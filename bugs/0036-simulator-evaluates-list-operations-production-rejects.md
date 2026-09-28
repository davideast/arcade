---
id: 0036
title: The Firestore rules simulator evaluates `list + list` and a slice with no elements, both of which production rejects as evaluation errors
severity: major
package: pyric
pyric_commit: dbc35150
found_in: restructuring the Reversi move rule to fit production's expression budget
status: open
---
## Summary

Production does not concatenate lists with `+`: `['a'] + ['b']` is an evaluation error ("Unsupported operation error. Received: list + list"). It also rejects a slice with no elements: `['a', 'b'][0:0]` is "Index out of bound error. Index: [-1]". The simulator on local-6 evaluates both, so a rule built on either passes every simulated case and denies every request in production. The first version of the restructured Reversi move rule did: it was allowed for every real move in the sandbox and denied for all 13 in the Rules Test API.

Pyric main 8b3c2c84 already rejects `list + list` (the `'+'` case in `simulator/evaluator.ts`); the empty slice is still accepted there.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0036.ts
```

The script simulates four `get` rules: `list + list`, a slice `[0:0]`, and as controls `concat()` and a slice `[0:1]`. The production decisions in the script come from the Rules Test API on digame-mas.

## Expected

`list + list` and `[0:0]` DENY; the controls ALLOW.

## Actual

On local-6 (exit 1):

```text
(['a'] + ['b']).size() == 2: simulate ALLOW; production DENY
['a', 'b'][0:0] == []: simulate ALLOW; production DENY
['a', 'b'].concat(['c']).size() == 3 (control): simulate ALLOW; production ALLOW
['a', 'b'][0:1] == ['a'] (control): simulate ALLOW; production ALLOW
```

## Suspected cause

`packages/pyric/src/rules/simulator/evaluator.ts`, `case 'sliceAccess'`: the checks reject a negative or non-integer index and an end past the length, then return `obj.slice(start, end)`. Production computes the last index as `end - 1` and rejects it when it is negative, so `[i:i]` with `i == 0` is an error. Whether `[i:i]` with `i > 0` is also an error was not measured.

## Suggested fix and failing test

Measure `[0:0]`, `[1:1]` and `[2:1]` on a list and a string in the Rules Test API, then make the slice case raise an `EvalError` for each form production rejects. Failing tests first in the simulator's slice tests.

## Workaround in pyric-games

The Reversi move rule sums per-direction counts instead of concatenating lists, and a direction with reach 0 checks no run instead of slicing `[0:0]`.
