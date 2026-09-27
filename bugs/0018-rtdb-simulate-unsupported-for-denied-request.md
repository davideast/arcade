---
id: 0018
title: RTDB simulate reports UNSUPPORTED instead of DENY when the deepest rules node on the path has no rule of the request's kind
severity: minor
package: pyric
pyric_commit: 9c125203
found_in: Air Hockey rules test (64 of 2,174 cross-checked requests)
status: fixed
fixed_in: dbc35150 (#791, 5898a8ee)
---
## Summary

For a request whose deepest matching rules node exists but has no rule of the request's kind (a node with only children, or only a `.validate`), `simulate` returns `NO_MATCHING_RULE`, which the `rtdbRules` handle reports as `decision: 'UNSUPPORTED'`, even when an ancestor's rule was evaluated and was false. RTDB denies what no rule grants, and the sandbox denies these requests, so `simulate` and the sandbox disagree on ordinary denials. In Air Hockey, a stranger reading `/airhockey/{match}/{host}/meta`, a guest writing `/frame/puck`, and a host writing one puck coordinate all came back UNSUPPORTED.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0018.ts
```

The root's `.read` and `.write` are `false`; `/rooms/$id` has a `.read`, a `.write` that requires `n < 10`, and a child `n` with only a `.validate`.

## Expected

All three requests are DENY in `simulate`, as in the sandbox.

## Actual

```text
write /rooms/r1/n = 50 (the room .write is false; n has only a .validate): sandbox DENY, simulate UNSUPPORTED (No 'write' rule found for path '/rooms/r1/n')
write /elsewhere (only the root rule, false): sandbox DENY, simulate DENY
read /rooms (only the root rule, false): sandbox DENY, simulate UNSUPPORTED (No 'read' rule found for path '/rooms')
```

## Suspected cause

`packages/pyric/src/rules/rtdb/simulation/handler.ts:600-612`: after no ancestor grants, the denial is reported against the deepest ancestor, and when that node has no rule of the operation's kind it returns the error `NO_MATCHING_RULE` instead of a denial, even though ancestor rules were evaluated. `DocumentRtdbRuleset.runOne` (`packages/pyric/src/rules/api/rtdb.ts:98-110`) turns any unsuccessful result into UNSUPPORTED. The sandbox's `RulesEvaluator` folds `no-rule` to deny (`packages/pyric/src/database/sandbox/rules-eval.ts`), so only `simulate` shows it.

## Suggested fix and failing test

When no ancestor grants, return a DENY with the deepest ancestor that has a rule of the operation's kind as `matchedPath` (and a plain DENY with "no rule grants" when none has one, matching production's default). Failing test first: the repro's three requests in `test/rules/rtdb/simulation/handler.test.ts`.

## Workaround in pyric-games

The Air Hockey sandbox test counts these denials apart (64 in a run) and fails on any other disagreement; the unit test lists the two cases it expects to come back UNSUPPORTED.

## Fixed

Fixed by Pyric PR #791, merged as 5898a8ee, and verified on Pyric main dbc35150 (vendored as local-6). RTDB `simulate` now reports DENY when no rule on the path grants the request. `bun bugs/repro/0018.ts` exits 0: all three requests are denied by the sandbox and by `simulate`.

Workaround dropped: the Air Hockey tests no longer count these denials apart. The unit test expects every case to pass, and in the sandbox test `simulate` agrees with the sandbox on every case: 835 of 835 in the late match and 1432 of 1432 in the full match.
