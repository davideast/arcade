# Game rule patterns

Each pattern names the checks a rule needs. Look up exact stdlib signatures with `rules_stdlib_get` before using them.

## One module per game, one main file

```rules
// games/chess/chess.rules
rules_version = '2+modules';
import { validCreate, validJoin, canCancel } from 'lobby';
import { isMyTurn, turnFlipped } from 'turns';
export function chessMove() { ... }

// firestore.modules.rules
rules_version = '2+modules';
import { chessCreate, chessJoin, chessCancel, chessMove, chessResign } from '../games/chess/chess';
service cloud.firestore {
  match /databases/{database}/documents {
    match /chess/{matchId} {
      allow update: if resource.data.status == 'playing' && (chessMove());
      ...
    }
  }
}
```

Relative imports resolve from the importing module's directory, and a module may import the stdlib or other modules. Keep `match` blocks and path variables in the main file and pass path segments into module functions as they are; a module converts them with `string()` or `int()` where it needs to.

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

For a `board` map, the client writes the filled cell's key to `lastMove`.

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

Have the client also write `lastBelow`, the key of the cell beneath `lastMove` (`''` on the bottom row). One `matches()` over the real pairs pins it, and the cell beneath must be occupied:

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

A win check is an OR of every line, each an AND of cells: 8 lines for tic-tac-toe, 69 for Connect Four. Generate them with a script from the board size; hand-written lists miss lines. On boards larger than about 7x7, split the check into four functions by direction (rows, columns, two diagonals) to keep each boolean chain under the compiler's depth limit, and OR them in the win rule.

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

## Movement games without a config document: bounded geometry and replay

When legal geometry is too large to keep as data, split it:

- **Enforce what one step or hop needs.** For a single diagonal step or jump, look up file and rank with map literals (`{'a': 1, 'b': 2, ...}[sq[0:1]]`), then check the distances and that the captured square is the midpoint: `file(captured) * 2 == file(from) + file(to)`.
- **Constrain the extra squares a special move names.** Castling may change exactly its rook's two squares (`extra == ['f1', 'h1']` for the king moving e1 to g1); en passant exactly the passed pawn's square, and only when the move lands on the stored `enPassant` square. Without that, a pawn move can delete any piece by naming it as extra.
- **Replay the rest.** Multi-hop paths, check, mandatory captures and win claims are checked by every client's replay of the move from the stored previous position (see the skill's "Detect what rules can't prevent").

## Multi-document moves: a batch whose rules check each other

A move that creates documents (a card played, a shot fired) writes them and the match update in one batch. Each side's rule checks the other through `getAfter()`, `exists()` and `existsAfter()`:

```rules
// The match update names a shot document that is new in this batch.
&& !exists(/databases/$(db)/documents/battleship/$(id)/shots/$(request.resource.data.lastShot))
&& existsAfter(/databases/$(db)/documents/battleship/$(id)/shots/$(request.resource.data.lastShot))

// The shot document's rule checks the match after the batch names it.
&& getAfter(/databases/$(db)/documents/battleship/$(id)).data.lastShot == shotId
&& getAfter(/databases/$(db)/documents/battleship/$(id)).data.moveCount == before.moveCount + 1
```

- Make the subdocuments create-only. A repeated id then fails as an update, which blocks firing at a cell twice or replaying a played card without extra checks.
- Name subdocument ids after what they record (`h07` for the host's shot at cell 7) and check the prefix, so one player can't take the other's id.
- Checks on both sides guard each other, so removal probes find some of them redundant. Keep them; record which.

## Hidden information the rules still referee

Rules read any document with `get()`, whatever its read rules say:

- **Private placement:** keep each fleet in a create-only document only its owner can read until the match ends. The shot rule reads the defender's fleet with `get()` and requires `request.resource.data.hit == (cell in fleet.cells)`, so the attacker never sees the fleet and still can't lie about hits.
- **Private hands:** store the deck as one document per card, readable only by the player a `draws/{i}` document names, until a `played/{i}` document makes it public. The play rule checks that the mover drew the card, with `get()` on the draws document.
- The dealer's shuffle is trusted: rules have no random source. Commit-reveal between players removes that trust if the game needs it.

## Rematch

On the game-over screen, the presser creates the new match and a create-only `rematches/{game}/matches/{finishedMatchId}` document naming it, in one batch. Its rule requires a participant of the finished match, a finished status, and a new match that did not exist before the batch and does after (`!exists` and `existsAfter`). The other players read it and join through the normal join rule. Key it by game and match id; match ids alone can collide across collections.

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

## Fair dice: commit and reveal

Rules can't roll dice, but they can make a roll fair. The roller commits `sha256(salt)` first; every other player then adds a nonce; the roller reveals the salt last. Rules check the salt against the commitment with `hashing.sha256`, then derive the dice from `sha256(salt + nonces)` and require the stored dice to equal the derivation. No single player controls a roll: the roller commits before seeing the nonces, and the others choose nonces without seeing the salt.

- Derive with operations rules have: take hex characters of the digest, skip the ones that would bias the result (Yacht drops `c` to `f` and maps each remaining digit `v` to `v % 6 + 1`), and state the derivation in the module header.
- Kept dice are a list of positions; a reroll may change only the others, and the roll count caps at three.
- A roller who refuses to reveal stalls the match but can't reroll. Pair it with a turn clock if stalling matters.
- Cheats to test: a reveal that doesn't match its commitment, dice that don't match the derivation, a different salt with its own derived dice, a nonce written for another seat, a changed kept die, a fourth roll.

## Directional captures: store the reach, check each direction

A move that captures along lines (Reversi) can't be searched in rules. Store what the move claims per direction (for example `lastMove = { at, runs[8] }`, the number of opponent pieces captured in each direction) and check each direction in its own function: the squares were the opponent's, the square past them is the mover's, and they now belong to the mover. Key the board so a step is a fixed offset and a step off the board lands on a missing key, so no bounds checks are needed. Then check the totals: the counts change by the captured number, and exactly that many squares plus one changed.

- Split by direction to stay under the 98-term chain limit, and nest the per-square checks so evaluation stops at the claimed reach.
- Measure the runtime budget, not only the static estimate: evaluate real moves in the sandbox and look at the worst case. A long capture in every direction can approach 1,000 expressions.
- A pass and the end of the game need a search; use replay-and-flag.

## Real-time play on the Realtime Database

Firestore rules referee turns; a real-time game (Air Hockey) runs on the Realtime Database, with the lobby and the result in Firestore.

- **Authority:** the host simulates and writes the shared state (puck, score) about 20 times a second; the guest writes only its own input. Clients interpolate between frames.
- **Paths:** put the host's uid in the live path (`/airhockey/{match}/{hostUid}`) so nobody else can take over a match. Mirror what the RTDB rules need from Firestore (the guest's uid, the status) into a `meta` node the host writes once, because RTDB rules can't read Firestore.
- **Rules:** field ownership (host fields, guest fields), numbers within the table, the score rising by one per goal for one side, writes only while `meta.status` is playing, and each ending written once.
- **Presence:** each player writes its presence with an `onDisconnect` write of `false`. A forfeit is allowed only while the other player's stored presence is `false`; the Firestore result can't check presence, so every client compares it with the live match and flags a mismatch.
- **What rules can't check:** the physics. A cheating host can move the puck or invent goals; the guest flags jumps and goals that couldn't happen between frames.
- Write the RTDB rules in TypeScript with Pyric's builders from `pyric/rules` (`defineRtdbRules`, `rtdbRules`), generate `database.rules.json` from them, and fail a check when the JSON drifts from the source. Probe the TypeScript source, not the JSON.

## Storage-backed replays and a leaderboard

A single-player game can still have a fair leaderboard when the proof is stored. Sokoban writes the score to Firestore first, then uploads the move list to Storage.

- **Storage rules:** only the owner writes under their own uid path; objects are create-only; contentType and size are bounded; and a cross-service check (`firestore.get()` on the owner's score) requires the score to name this object and its size to equal the claimed move count. Anyone signed in may read, so other clients can replay.
- **Firestore rules:** the score is the owner's, for a real level, with integer counts between the level's minimum and a cap, naming an object under the owner's uid, and it must beat the stored best.
- **What rules can't check:** whether the moves solve the level. Every client downloads each entry, replays it, and flags one that doesn't solve the level or doesn't match its counts, or whose move list never arrived.
- **Deploying:** production's `firestore.get()` from Storage rules reads the `(default)` database, and the Storage service agent needs the Firestore service agent role. Keep the score in `(default)` or the cross-service check denies every upload.
