---
id: 0012
title: A Realtime Database write evaluates the .validate rules of unchanged sibling nodes, so a rule that requires a change denies unrelated writes
severity: major
package: pyric
pyric_commit: 9c125203
found_in: Air Hockey RTDB rules (every host frame was denied by the score's one-goal rule)
status: open
---
## Summary

When a client writes one node, the sandbox and `simulate` also evaluate the `.validate` rule of every sibling node that has one, against its unchanged value. A `.validate` that constrains a change, such as a counter that may only grow by one (`newData.val() == data.val() + 1`), then fails on the sibling that wasn't written, and the unrelated write is denied. In Air Hockey, with the score's one-goal rule in `.validate`, every host frame (a write to `frame`) and every guest mallet write (a write to `guestMallet`) was denied because `score` didn't change.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0012.ts
```

The rules give `/rooms/$room/count` the rule `newData.val() == data.val() + 1` and `/rooms/$room/title` the rule `newData.isString()`. With `count` stored as 1, `alice` writes `/rooms/r1/title`.

## Expected

The write is allowed. It evaluates the `.write` rules from the root to `title`, the `.validate` rules on that path, and the `.validate` rules of the written value's descendants. `count` is not written, so its `.validate` is not evaluated. That is the contract Pyric's own handler documents (`handler.ts:62-64`: "every rule on the path from the root to the write location, then every descendant rule present in the written value"), and the r15 capture (`rules-rtdb-r15-validate-ancestor-scope`) pins the ancestor half of it against production.

## Actual

```text
sandbox: PERMISSION_DENIED: Permission denied
sandbox: write to /rooms/r1/title DENIED
simulate: DENY (/rooms/$room/count: Validation rule evaluated to false)
```

The deciding rule is the sibling's (`/rooms/$room/count`).

## Suspected cause

`findFailingValidate` in `packages/pyric/src/rules/rtdb/simulation/handler.ts` walks sibling subtrees that are not on any write path: the "Sibling branch" at lines 241-256 (and the wildcard case at 204-218) descends into every existing sibling with a `.validate` whenever `shouldValidateSiblingSubtree` (line 84) is true, which it is for any write below the root (`currentSegments.length > 0`). It came in with 1e013481 (#550, fail-closed invariants); no oracle observation covers sibling scope. The sandbox reaches the same walk through `RulesEvaluator.evaluate` (`packages/pyric/src/database/sandbox/rules-eval.ts`).

## Suggested fix and failing test

Validate only the nodes on the write paths and the descendants of each written value (for a multi-path update, every written path), and drop the sibling branch. Failing test first: the repro as a unit test in `test/rules/rtdb/simulation/handler.test.ts` (a sibling whose `.validate` fails on its unchanged value must not deny the write), plus a corpus scenario (r22, validate sibling scope) captured against production to pin it.

## Workaround in pyric-games

Air Hockey's rules keep every value check in `.write` (a node's `.write` is evaluated with the merged value for writes at or below it, and nothing above grants) and keep only type checks and `$other: false` in `.validate`, which pass on unchanged values. Before that, `score`, `meta` and the puck's tick carried an "unchanged" branch so their `.validate` passed when a sibling was written.
