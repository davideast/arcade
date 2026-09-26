---
name: firestore-game-rules
description: Build a turn-based multiplayer game on Firestore where Security Rules are the referee. Covers the game document, the rules that verify each move, the client that proposes moves, and the cases that prove a cheat is denied. Use when the user wants a board, card, or turn-based game with Firestore or Pyric. Don't use for real-time action games (use a server or Realtime Database) or for general rules review (use firestore-rules-audit).
---

# Build turn-based games with Firestore Security Rules

A game is one Firestore document. A move is an update to it. The client computes the next state and proposes it; the rules verify that the proposal is one legal move by the right player, then Firestore stores it. Rules evaluate boolean expressions only: no loops, no recursion, and a limited evaluation budget. The whole design follows from that.

## Two objects

| Object | Holds | Use it for |
|---|---|---|
| `resource.data` | The game before the write | Who may act (`currentTurn`), what was on the board |
| `request.resource.data` | The proposed game after the write | What the new state must look like |

Authorize from `resource.data`. The writer controls every field of `request.resource.data`, including the next `currentTurn`.

## Steps

1. **Decide what the rules verify and what the client derives.** Rules verify that each write is a legal move by the current player. A client can derive facts that need search, such as checkmate or "no legal moves left", from the committed board. Write down which fields the rules trust and which they only store. Complete when every field of the game document has an owner: rules-verified, client-derived, or immutable.

2. **Design the document.** Use the stdlib field convention: `host` and `guest` (UIDs, `guest` is `''` while waiting), `currentTurn` (`'host'` or `'guest'`), `status` (`'waiting'`, `'playing'`, `'won'`, `'draw'`), `winner`, `moveCount`. Name cells `c<col>r<row>`, in a `board` map or as top-level fields. Every move records the cell it filled in `lastMove`, so rules address it as `board[request.resource.data.lastMove]`. Gravity games also record `lastBelow`, the cell beneath (`''` on the bottom row). Complete when you can write the create payload and one move's before and after documents by hand.

3. **Write the rules.** In the Pyric playground, call `build_game_rules` for grid placement games and review its output rather than hand-writing win lines. Boards up to 7x6 (Connect Four) are safe; on larger boards the full win-line check exceeds the evaluation budget for many real wins (see [references/limits.md](references/limits.md)). Otherwise start from `rules_version = '2+modules'` and import the game modules: `lobby`, `turns`, `state`, `geometry`, `counters`, `timing`, `transitions`, `lifecycle`. Call `firestore_rules_stdlib_list`, then `firestore_rules_stdlib_get` for each module you import; never guess a function name or signature. Structure the rules with [references/patterns.md](references/patterns.md). Complete when every state transition (join, move, win, draw, resign, timeout) has its own `allow update`.

4. **Resolve and lint.** Production does not understand `2+modules`. Run `firestore_resolve_modules` (or `pyric firestore rules resolve`) to produce a plain `rules_version = '2'` file, then `firestore_lint_rules` (or `pyric rules lint --service firestore`). Complete when the linter reports no errors and every warning is fixed or explained. See [references/limits.md](references/limits.md) for what the linter measures.

5. **Prove cheats are denied.** Run the case list below with `firestore_simulate_rules`, using explicit before and after documents. Every case must match its expectation. Complete when all allow cases pass and all deny cases are denied. If a legal move is denied, `sandbox_inspect` shows which rule and expression decided it.

   The simulator does not enforce the runtime expression budget; the linter only estimates it. Before shipping a large board, run the same cases through Firebase's Rules Test API (`projects.test`), which evaluates against production without deploying.

6. **Write the client.** See "Client" below. Complete when two signed-in users can play a full game in the sandbox, and a tampered write from the browser console is denied.

## Hard rules

- **Every allow rule that accepts a move checks the whole move.** That includes win and draw claims. A win rule that checks only "the new board has a line" lets a player write three marks at once and claim the win. Each move rule needs: the current player, the turn flip, `moveCount + 1`, the placed cell was empty and now holds the mover's mark, and `diff(resource.data).affectedKeys().hasOnly([...])` listing exactly the fields that move may change (include `status` and `winner` for claims). With a `board` map, also check `board.diff(resource.data.board).affectedKeys().hasOnly([lastMove])`.
- **Create starts from an empty board.** Otherwise a host creates a game with a winning line already on it.
- **Split `allow update` by transition, and gate each one first.** Firestore evaluates at most 1,000 expressions per request, counting each link of an `&&` chain, across every `allow` rule it tries. Start each rule with one mutually exclusive comparison and group the rest in parentheses: `allow update: if request.resource.data.winner == 'host' && ( ... );`. A write for another transition then stops after one comparison. Past the budget, a legal move is denied with an ordinary `permission-denied`.
- **Never trust `request.resource.data` for identity.** Participants stay unchanged on every move (`participantsUnchanged()` from `state`).
- **Terminal states are terminal.** Every move rule requires `resource.data.status == 'playing'`.
- **Test in the sandbox.** Never deploy rules to a shared Firebase project to find out whether they work.

## Cases every game must pass

| Case | Expect |
|---|---|
| Legal move by the current player | allow |
| Legitimate winning move with a correct claim | allow |
| Legitimate final move declared a draw | allow |
| Move by the player who is not on turn | deny |
| Move by a signed-in user who is not a participant | deny |
| Move onto an occupied cell | deny |
| Two or more cells written in one move | deny |
| Win claim on a board with no winning line | deny |
| Win claim that also writes or overwrites another cell | deny |
| Draw claimed before the board is full, or with extra cells | deny |
| `host`, `guest`, or `moveCount` changed out of sequence | deny |
| Any move after `status` is `won` or `draw` | deny |
| Create with a mark already on the board | deny |
| Join that also changes any field other than `guest` and `status` | deny |

Add game-specific cases: a floating piece or a spoofed `lastBelow` in a gravity game, captures, piece geometry, cooldowns. For boards larger than 7x6, also run real winning moves from late-game positions; a budget failure shows up only there.

## Client

- **Propose moves in a transaction.** Read the game, compute the next state from that read, and write it inside `runTransaction`, so the proposal is built from the current document. A stale proposal fails the turn check and the transaction retries or the UI refreshes.
- **Listen, don't poll.** Render from `onSnapshot` on the game document. The board shows only committed state; show a pending move separately until the write resolves.
- **Handle denial as a normal outcome.** A denied write means the move was illegal or stale. Keep the board as it was and tell the player.
- **Query the lobby the way the rules allow.** A list query must be provably allowed by the read rules. If only participants can read a game, add a separate read rule for open games (`resource.data.status == 'waiting'`) and query with the matching filter: `where('status', '==', 'waiting')`.

## What rules can't referee

- **Hidden information.** Anyone who can read a document sees all of it. Keep a hand or a ship layout in a per-player document (`games/{id}/private/{uid}`) readable only by its owner, and verify reveals with a commitment: store a hash first, check the revealed value against it later with the `hashing` namespace.
- **Randomness.** Rules have no random source. Dice and shuffles need a commit-reveal from both players or a trusted server.
- **Searches over future moves.** Checkmate, stalemate, and "no legal move" need search. Rules verify each move; the client derives these outcomes from the committed board.
- **Real-time play.** Many writes per second per game and sub-second latency don't fit one-document-per-move. Use Realtime Database or a server.
- **Abandonment.** Rules can let the waiting player claim a forfeit after a timeout. Store `lastMoveAt` with `isServerTimestamp`, and gate the forfeit rule with `cooldownElapsed('lastMoveAt', seconds)` from `timing`.

## References

- [references/patterns.md](references/patterns.md): the rule patterns, with the checks each one needs.
- [references/limits.md](references/limits.md): compiler and evaluator limits that shape game rules, and board sizes that fit.
