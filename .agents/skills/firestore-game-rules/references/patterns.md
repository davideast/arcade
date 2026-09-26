# Game rule patterns

Each pattern names the checks a rule needs. Look up exact stdlib signatures with `firestore_rules_stdlib_get` before using them.

## Lobby: create, join, cancel

```rules
import { validCreate, validJoin, canCancel } from 'lobby';
import { onlyFieldsChanged } from 'lifecycle';

allow create: if validCreate()
  && request.resource.data.currentTurn == 'host'
  && request.resource.data.moveCount == 0
  && request.resource.data.winner == '';
allow update: if validJoin() && onlyFieldsChanged(['guest', 'status']);
allow delete: if canCancel();
```

`validJoin()` checks the seat, the joiner, and the status change, but not the other fields. Pair it with `onlyFieldsChanged(['guest', 'status'])`, or the joiner can rewrite the board while joining. Validate the initial board on create: every cell empty, counters at their starting values.

## Every move: player, turn, count, participants

```rules
import { isMyTurn, turnFlipped } from 'turns';
import { isPlaying, moveIncremented, participantsUnchanged } from 'state';

function moveBasics() {
  return request.auth != null && isPlaying() && isMyTurn()
    && turnFlipped() && moveIncremented() && participantsUnchanged();
}
```

`isMyTurn()` reads `resource.data.currentTurn`, the turn before the write. Reading the turn from `request.resource.data` would let a player name themselves.

## Placement: one empty cell, the mover's mark, nothing else

This is the shape `build_game_rules` emits for a `board` map. The client writes the filled cell's key to `lastMove`.

```rules
function placedOneCell() {
  let before = resource.data;
  let after = request.resource.data;
  return before.board[after.lastMove] == ''
    && after.board[after.lastMove] == before.currentTurn
    && after.board.diff(before.board).affectedKeys().hasOnly([after.lastMove])
    && after.diff(before).affectedKeys()
         .hasOnly(['board', 'lastMove', 'currentTurn', 'moveCount', 'status', 'winner']);
}
```

- The first two lines check the cell the client says it played: empty before, the mover's mark after.
- The board `diff()` proves no other cell changed. The document `diff()` proves only move fields changed. `status` and `winner` are listed because claims change them; each transition rule below pins their values.
- `lastMove` must name an existing cell: a key the board map doesn't have makes `before.board[...]` error, and the rule denies.
- With cells as top-level fields instead, drop the board `diff()` and list the cell in the document `diff()`: `hasOnly(['lastMove', 'currentTurn', 'moveCount', 'status', 'winner', after.lastMove])`.

Map keys can be any string expression. Production accepts a stored field value, a function parameter, a `let` binding, a value read from a `get()` result, and a concatenated name such as `b['c' + string(col) + 'r' + string(row)]`. Nested map diffs are exact: a two-cell change fails `hasOnly([lastMove])`.

## Gravity

`build_game_rules` has the client also write `lastBelow`, the key of the cell beneath `lastMove` (`''` on the bottom row). One `matches()` over the real pairs pins it, and the cell beneath must be occupied:

```rules
&& (after.lastMove + ':' + after.lastBelow).matches('c0r0:|c0r1:c0r0|c0r2:c0r1|...')
&& (after.lastBelow == '' || before.board[after.lastBelow] != '')
```

Without the `matches()`, a client names any occupied cell as `lastBelow` and places a floating piece. Add `lastBelow` to the document `diff()` list.

## Split transitions, each checking the whole move

```rules
// Normal move
allow update: if request.resource.data.status == 'playing' && (
  request.resource.data.winner == '' && moveBasics() && placedOneCell()
);

// Win claim by the host (repeat for the guest with 'guest' and its line check)
allow update: if request.resource.data.winner == 'host' && (
  request.resource.data.status == 'won' && moveBasics() && placedOneCell()
  && hasWonHost(request.resource.data.board)
);

// Draw on the final cell
allow update: if request.resource.data.status == 'draw' && (
  request.resource.data.winner == '' && moveBasics() && placedOneCell()
  && request.resource.data.moveCount == 9   // the number of cells on the board
);
```

- Each rule starts with a comparison the others can't pass, and groups the rest in parentheses, so a write for another transition costs one expression.
- The win claim does not skip placement. Without `placedOneCell()`, a player writes a whole line in one move and claims it; production allowed exactly that before the generator was fixed.
- A normal move does not check for a win. A player who completes a line and still writes `'playing'` only gives up their own win.

## Win lines: generate them

A win check is an OR of every line, each an AND of cells: 8 lines for tic-tac-toe, 69 for Connect Four. Generate them; hand-written lists miss lines. In the playground, `build_game_rules` does this. On boards larger than about 7x7, split the check into four functions by direction (rows, columns, two diagonals) to keep each boolean chain under the compiler's depth limit, and OR them in the win rule.

## Movement games: config document, counters, move types

Checkers and chess move a piece from one cell to another. Keep legal geometry as data:

```rules
import { validSimpleMove, validJumpMove } from 'geometry';

function config() { return get(/databases/$(database)/documents/gameConfig/checkers).data; }
```

- `validSimpleMove(config())` checks `cfg.moves[piece][from][to]`, with `piece` read from `resource.data`, so the client can't choose it. `get()` of the same path is read once per request.
- Create the config document once with the Admin SDK or the sandbox, and make it read-only: `allow write: if false`. If it's missing, every move is denied.
- Keep lookup documents small. A document near 40,000 indexed entries was rejected even under the size limit; split by piece or side, and exempt the fields from indexing.
- Win by counters, not board scans: `hostCount`, `guestCount`. A capture decrements the opponent's count by exactly one (`incrementedBy('guestCount', -1)` from `counters`); other moves leave both unchanged.
- Gate each move type with a stored label (`moveType == 'capture'`) as the first comparison of its rule.
- Every move rule still needs a changed-fields check listing the from cell, the to cell, any captured cell, and the metadata fields. Checking only that the moved piece arrived lets a player change other squares in the same write.

## Ending a game early

```rules
import { cooldownElapsed } from 'timing';
import { isServerTimestamp } from 'lifecycle';

// Resign: either participant, only while playing
allow update: if request.resource.data.status == 'resigned'
  && isPlaying() && participantsUnchanged()
  && (request.auth.uid == resource.data.host || request.auth.uid == resource.data.guest)
  && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'winner'])
  && request.resource.data.winner == (request.auth.uid == resource.data.host ? 'guest' : 'host');

// Timeout forfeit: the player who is waiting claims it
allow update: if request.resource.data.status == 'forfeit'
  && isPlaying() && participantsUnchanged()
  && ((resource.data.currentTurn == 'host' && request.auth.uid == resource.data.guest)
      || (resource.data.currentTurn == 'guest' && request.auth.uid == resource.data.host))
  && cooldownElapsed('lastMoveAt', 300)
  && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'winner']);
```

Every move rule must also require `isServerTimestamp('lastMoveAt')` and list `lastMoveAt` in its changed fields, so the stored time can't be forged.
