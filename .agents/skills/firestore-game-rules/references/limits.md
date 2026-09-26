# Limits that shape game rules

Game rules hit Firestore's compiler and evaluator limits sooner than application rules do, because win lines and move tables are long. `firestore_lint_rules` measures what it can before deploy. The full list, with invalid and valid examples, is in Pyric's docs at `packages/site-docs/src/content/secure/firestore-rules-limits.md`.

| Limit | Value | What happens |
|---|---|---|
| Rules source size | under 256 KB | Deploy fails |
| Flat `&&` or `\|\|` chain | 98 terms compile, 99 fail | Deploy fails. Group terms into balanced sub-expressions or split by direction |
| `let` bindings per function | 11 compile, 12 fail | Deploy fails |
| `get()`, `getAfter()`, `exists()` and `existsAfter()` calls | 10 per single-document request, 20 per batched write or transaction | The next one fails and the request is denied. Repeated reads of the same path count once. Pyric's sandbox may not enforce this; test large batches against production |
| Expressions evaluated | 1,000 per request, counting each link of an `&&` chain, across every `allow` rule Firestore tries | The request is denied with an ordinary `permission-denied`. Only production enforces it; the linter estimates |

## What the budget means for games

- A denied legal move is often the budget, not the logic. Lint, then check the trace with `sandbox_inspect`, then run the case through the Rules Test API.
- A rule that fails late has still spent its budget. Start each `allow update` with one mutually exclusive comparison (`status`, `winner`, `moveType`) and group the rest in parentheses, so other transitions stop at the first comparison.
- Keep move validation cheap: a stored cell key, one `diff().affectedKeys().hasOnly(...)`, and a `matches()` for gravity. A win claim then spends its budget on the win check.
- Replace board scans with counters. Checking 32 checkers squares for remaining pieces costs 64 expressions; `request.resource.data.guestCount == 0` costs one.

## Board sizes

Real winning moves from late-game positions of random games, evaluated by production through the Rules Test API against generated rules that check every win line on the board:

| Board | Win length | Real wins denied |
|---|---|---|
| 3x3 | 3 | 0 |
| 7x6, gravity (Connect Four) | 4 | 0 of 240 |
| 8x7, gravity | 4 | 34 of 235 |
| 9x9 | 5 | 106 of 408 |
| 11x11 | 5 | 142 of 276 |
| 11x11, gravity | 4 | 113 of 200 |

Tic-tac-toe and Connect Four fit. On larger boards, a full-board win check runs out of budget for many legitimate wins. Checking only the lines through `lastMove` would bound the cost; the generator does not do that yet, so don't ship a larger board without measuring real wins in production.

With win lines split into four direction functions, five in a row compiles up to 11x11; at 12x12 one direction's lines exceed the chain limit. Compiling is not the same as fitting the runtime budget.

Movement games measured earlier with a config document, counters, and move-type gates: checkers and chess (with checkmate derived by the client) fit on 8x8.

## Pyric's module resolver: current limitations

These are Pyric limitations, not Firestore ones; production accepts the same expressions once resolved. Work around them until they're fixed:

| Rejected inside a module | Workaround |
|---|---|
| A method on a field of a `get()` or `getAfter()` result, or on a `let` or parameter bound to one (`get(p).data.players.size()`) | Compare with `==` or test membership with `in`, which are operators. Store what you'd compute (a `size` field kept equal to `players.size()` by the rule that changes it) |
| A method on a map or set passed as a parameter (`valid(request.resource.data.shot)` calling `shot.keys()`) | Write `request.resource.data.shot.keys()` in full, or call a helper function at each use instead of passing its result |
| `string()` and `int()` | Convert in the main file, where path variables live, and pass the result: `allow create: if cardCreate(database, matchId, int(i));` |

## Sandbox speed

Pyric's sandbox currently re-parses the whole ruleset on every rule check, so a check costs time in proportion to the ruleset's size (about 150 ms each with six games' rules, about 60 KB resolved). A 140-document batch then takes about 20 seconds, and a full rules test takes minutes. Keep a fast test mode for removal probes, and expect large batches to be slow under `vite dev` until that's fixed.
