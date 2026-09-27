---
id: 0035
title: In the Firestore rules simulator, `x in <set>` is false for an element the set holds
severity: major
package: pyric
pyric_commit: 8b3c2c84
found_in: restructuring the Reversi move rule to fit production's expression budget
status: open
---
## Summary

`'k' in ['k'].toSet()` is false in `firestoreRules(...).simulate` and in the sandbox, and true in production. The same holds for the sets that `MapDiff.affectedKeys()`, `changedKeys()`, `unchangedKeys()` and the other set-returning methods produce. A rule that tests set membership, such as `'board' in request.resource.data.diff(resource.data).affectedKeys()`, is denied locally and allowed in production. The negated form `!('board' in ...)` is allowed locally for every request, so a check meant to deny a change never denies.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0035.ts
```

The script simulates four rules, each allowed in production (checked with the Rules Test API on digame-mas): membership in a literal set, in `affectedKeys()`, in `unchangedKeys()`, and, as a control, in a list.

## Expected

All four ALLOW.

## Actual

On local-6 (exit 1):

```text
'k' in ['k'].toSet(): simulate DENY; production ALLOW
'k' in board.diff(before).affectedKeys(): simulate DENY; production ALLOW
'u' in board.diff(before).unchangedKeys(): simulate DENY; production ALLOW
'k' in board.keys() (a list, control): simulate ALLOW; production ALLOW
```

## Suspected cause

`packages/pyric/src/rules/simulator/evaluator.ts`, `case 'inExpr'`: an array is searched with value equality, and any other object is treated as a map and tested with `Object.hasOwn(collection, String(element))`. A rules set is a wrapper object (`{ items: [...] }` in the trace), so the element is looked up as a property name and not found. Pyric main 8b3c2c84 has the same code.

## Suggested fix and failing test

Before the map branch, test for the set wrapper and search its items with `rulesValuesEqual`, as the list branch does. Failing tests first in the simulator's operator tests: membership of a present and an absent element in a literal set, in `affectedKeys()`, `changedKeys()`, `addedKeys()`, `removedKeys()` and `unchangedKeys()`, and the negated forms.

## Workaround in pyric-games

The Reversi move rule tests sets with `hasAll` and `hasAny`, which the simulator evaluates correctly, and never with `in`.
