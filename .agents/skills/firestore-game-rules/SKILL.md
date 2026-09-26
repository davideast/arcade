---
name: firestore-game-rules
description: Build a turn-based multiplayer game on Firestore where Security Rules are the referee. Covers the game documents, the rules that verify each move, the client that proposes moves, the sandbox tests that prove every cheat is denied, and detection for what rules can't check. Use when the user wants a board, card, or turn-based game with Firestore or Pyric. Don't use for real-time action games (use a server or Realtime Database) or for general rules review (use firestore-rules-audit).
---

# Build turn-based games with Firestore Security Rules

A game is a match document, sometimes with subcollections. A move is a write, often a batch. The client computes the next state and proposes it; the rules verify that the proposal is one legal move by the right player, then Firestore stores it. Rules evaluate boolean expressions only: no loops, no recursion, and a limited evaluation budget. The whole design follows from that.

## Two objects

| Object | Holds | Use it for |
|---|---|---|
| `resource.data` | The document before the write | Who may act (`currentTurn`), what was on the board |
| `request.resource.data` | The proposed document after the write | What the new state must look like |

Authorize from `resource.data`. The writer controls every field of `request.resource.data`, including the next `currentTurn`.

## Steps

1. **Decide, field by field, what the rules enforce and what they can't.** Rules enforce anything checkable from the documents a write touches plus a bounded number of `get()` reads. They can't search (checkmate, "no legal move"), run physics, or loop over a variable-length path. For each thing rules can't check, plan detection instead: store the state before the move and the move's input, and have every client replay it and flag a mismatch (see "Detect what rules can't prevent"). Complete when every field has an owner: rules-verified, replay-verified, or immutable.

2. **Design the documents.** Use the stdlib field convention: `host` and `guest` (UIDs, `guest` is `''` while waiting), `currentTurn` (`'host'` or `'guest'`), `status` (`'waiting'`, `'playing'`, `'won'`, `'draw'`, `'resigned'`), `winner`, `moveCount`. Record what a move touched (`lastMove`, and for multi-square moves the extra squares) so rules can address it without searching. For more than two players, keep `players` as a list, a `turn` index, and per-player counts. Put per-item private data in its own documents (one per card, one fleet per player). Complete when you can write the create payload and one move's before and after documents by hand.

3. **Write the rules as a module per game.** Give each game its own `games/<game>/<game>.rules` module (`rules_version = '2+modules'`) that imports the stdlib (`lobby`, `turns`, `state`, `lifecycle`, and others) and exports one function per transition. A main `firestore.modules.rules` imports each game's module by relative path and holds only the `match` blocks. Call `rules_stdlib_list`, then `rules_stdlib_get` for each module you import; never guess a function name or signature. Structure the rules with [references/patterns.md](references/patterns.md), and keep them inside the limits in [references/limits.md](references/limits.md). Complete when every state transition (create, join, cancel, move, win, draw, resign) has its own `allow` and each move rule checks the whole move.

4. **Resolve.** Production does not understand `2+modules`. Run `pyric firestore rules resolve firestore.modules.rules --out firestore.rules` (or `rules_resolve_modules`) to produce a plain `rules_version = '2'` file; that file is what tests read and what deploys. Under `vite dev`, `pyric()` resolves and hot-reloads module files itself. Complete when the resolve succeeds and `firestore_lint_rules` reports no errors.

5. **Prove every cheat is denied, in the Node sandbox.** Write a test that plays seeded random games through the same write lists the client sends, each write as the acting player's identity: every real transition must be allowed, and before each one a set of cheats derived from it must be denied and leave the documents unchanged. Then removal-probe the rules: delete each check in turn, re-resolve, and confirm the test fails. A check whose removal isn't caught either needs a new cheat or is implied by another check; record which. See "Test harness" below. Complete when all real moves pass, all cheats are denied, and every probe is caught or explained.

6. **Write the client.** See "Client" below. Complete when two players in separate browser contexts can play a full game, and forged writes from the browser console are denied (or, for what rules can't check, flagged on every client).

## Hard rules

- **Every allow rule that accepts a move checks the whole move.** That includes win and draw claims. Each move rule needs: the current player, the turn flip, `moveCount + 1`, the moved piece belongs to the mover, the target was legal to take, and `diff(resource.data).affectedKeys().hasOnly([...])` listing exactly the fields that move may change. With a `board` map, also check `board.diff(resource.data.board).affectedKeys().hasOnly([...])` listing exactly the squares the move names.
- **Create starts from the exact initial state.** Compare the whole board to a literal (`request.resource.data.board == startBoard()`), and pin every counter, list and flag. Otherwise a host creates a game that is already won.
- **Split `allow update` by transition, and gate each one first.** Firestore evaluates at most 1,000 expressions per request, counting each link of an `&&` chain, across every `allow` rule it tries. Start each rule with one mutually exclusive comparison (`status`, `winner`, `lastAction`) and group the rest in parentheses.
- **Never trust `request.resource.data` for identity.** Participants stay unchanged on every move; the changed-fields list enforces it.
- **Terminal states are terminal.** Every move rule requires `resource.data.status == 'playing'`.
- **A cheat must be denied and leave nothing changed.** A test that only checks for `permission-denied` misses a batch that half-applied.
- **Test in the sandbox.** Never deploy rules to a shared Firebase project to find out whether they work, and never use the Firebase Emulator for this.

## Test harness

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin/firestore';

const sandbox = initializeSandbox();
getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(resolvedRules);
const host = getFirestore(sandbox.withAuth({ uid: 'host-uid' }));
const guest = getFirestore(sandbox.withAuth({ uid: 'guest-uid' }));
// Write lists: [{ type: 'set' | 'update', path, data }], applied with db.batch().
// sandbox.admin.getDocument(path) and setDocument(path, data) read and seed without rules.
```

- Share the write-list builders between the client and the test, so the test proves exactly what the browser sends.
- Derive cheats from each real move: the same write out of turn, by a stranger, with one field wrong, with an extra field, with one more square changed, with the claim changed. Seed late-game positions with `setDocument` to test wins, promotions and special moves that random play rarely reaches.
- Run the full test for every removal probe. The sandbox parses a ruleset once, so six games' rules tests take about 15 seconds together.
- Probe a check again whenever you rewrite it, even when its meaning is unchanged. Rewriting the arcade's rules found 8 of 29 rewritten checks that no case failed without, each fixed by adding a cheat.

## Cases every game must pass

| Case | Expect |
|---|---|
| Legal move by the current player | allow |
| Legitimate winning move with a correct claim | allow |
| Move by the player who is not on turn, or by a non-participant | deny |
| The mover's piece left in place too, or a second piece changed | deny |
| Moving the opponent's piece, or capturing your own | deny |
| Win claim without the winning condition, or naming the wrong winner | deny |
| A winner named while status stays `playing` | deny |
| `host`, `guest`, `currentTurn` or `moveCount` changed out of sequence | deny |
| Any move after the game ends | deny |
| Create with anything but the initial state, or for someone else | deny |
| Join that seats someone else or changes any other field | deny |
| Resign for the opponent, or by a stranger | deny |

Add game-specific cases for every check your rules make: captures, promotions, special moves, private reads, and each subdocument's create rule.

## Client

- **Propose moves in a transaction or batch.** Read the match, compute the next state from that read, and write it inside `runTransaction` (single document) or a `writeBatch` (a move that creates subdocuments), so the proposal is built from the current document.
- **Listen, don't poll.** Render from `onSnapshot`. The board shows only committed state.
- **Handle denial as a normal outcome.** A denied write means the move was illegal or stale. Keep the board as it was and tell the player.
- **Let the rules answer what the client can't know.** When the answer depends on data the player can't read (a hit on a hidden fleet), propose one answer and, if denied, the other; exactly one is stored.
- **Query the lobby the way the rules allow.** Query open matches with `where('status', '==', 'waiting')`, matched by a read rule that allows it.
- **Clean up.** When the host leaves a match still waiting for players, cancel it. Offer a rematch from the game-over screen rather than a new empty match.

## Detect what rules can't prevent

Rules can't run physics, search for checkmate, or check a multi-hop path's geometry. For those:

- Store the state before the move (`prevBoard`, `prevBalls`) and the move's input (`shot`, `lastMove`), and have the rules require the stored previous state to equal `resource.data`'s current state.
- Every client replays the move with the same pure logic and compares the result with what was stored. On a mismatch, show it on every client (a red status line and a toast naming the move and its player).
- Make the replay deterministic: integers for stored positions, and only `+ - * /` and `Math.sqrt` in physics, which IEEE 754 defines exactly.
- Test it: write a result consistent with the rules but not the logic, assert the rules allow it, and assert the replay flags it.

Randomness and a host-dealt deck are trusted, not enforced: rules have no random source. Say so in the game.

## References

- [references/patterns.md](references/patterns.md): the rule patterns, with the checks each one needs.
- [references/limits.md](references/limits.md): Firestore's compiler and evaluator limits, and how they shape game rules.
