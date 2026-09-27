---
id: 0022
title: In Realtime Database rules, == and != convert types in Pyric but not in production, so a mixed-type comparison is allowed where production denies
severity: major
package: pyric
pyric_commit: 9c125203
found_in: fixing 0014 (a production capture of strict and loose equality in RTDB rules)
status: open
---
## Summary

Pyric evaluates `==` and `!=` in Realtime Database rules with JavaScript's loose equality, which converts types before comparing: `5 == '5'` and `1 == true` are both true. Production does not convert: a capture against a deployed ruleset denied `newData.val() == '5'` when the number 5 was written and `newData.val() == true` when the number 1 was written. So a `.validate` or `.write` rule that expects a string, or a boolean, accepts a number in Pyric and rejects it in production. Same-type comparisons agree.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0022.ts
```

The script sets `{ a: { '.write': 'auth != null', '.validate': <rule> } }`, writes a value to `/a` in the sandbox as a signed-in user, and runs the same case through `rtdbRules(...).simulate`, for the two mixed-type cases production denied and one same-type control.

## Expected

`newData.val() == '5'` with the number 5, and `newData.val() == true` with the number 1: DENY in the sandbox and in `simulate`, as in production. `newData.val() == '5'` with the string `'5'`: ALLOW.

## Actual

On local-5 (exit 1):

```text
newData.val() == '5' with 5: sandbox ALLOW, simulate ALLOW (production DENY)
newData.val() == true with 1: sandbox ALLOW, simulate ALLOW (production DENY)
newData.val() == '5' with "5": sandbox ALLOW, simulate ALLOW (production ALLOW)
```

## Suspected cause

Confirmed by reading. `packages/pyric/src/rules/rtdb/grammar/simulator.ts:263-264`: `Comparison_looseEq` and `Comparison_looseNeq` evaluate with JavaScript `==` and `!=`. The production verdicts come from a Rules Test API capture taken while fixing 0014; those cases were dropped from that PR's scenario so it records no divergence.

## Suggested fix and failing test

Evaluate `==` and `!=` without type conversion (the same comparison as `===` and `!==` for primitive values), after confirming production's behavior for the remaining mixed pairs (number and string, number and boolean, null and missing data) with a capture recorded as a corpus scenario and observation. Failing tests first in `packages/pyric/test/rules/rtdb/grammar/simulator.test.ts` and the sandbox controls test: each case in this repro. Check the RTDB constraint builders, which emit `==` and `!=`, still produce the rules their docs describe.

## Workaround in pyric-games

Compare same-typed values only: check the type first (`newData.isString()`, `newData.isNumber()`, `newData.isBoolean()`) before an equality. Air Hockey's rules already check types first, so the game does not depend on this.
