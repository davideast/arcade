---
id: 0028
title: RTDB simulate reports UNSUPPORTED when a .validate expression throws during evaluation, where the sandbox and production deny
severity: minor
package: pyric
pyric_commit: 9c125203
found_in: fixing 0018
status: open
---
## Summary

When a Realtime Database `.validate` expression fails while it is evaluated, such as a string method called on a number, production denies the write and Pyric's sandbox does too. `rtdbRules(...).simulate` reports UNSUPPORTED for the same case, so a rules test that expects DENY fails and an agent reading the result is told the rule is beyond Pyric rather than that it denies.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0028.ts
```

The script sets `{ a: { '.write': 'auth != null', '.validate': "newData.val().toUpperCase() == 'A'" } }`, writes the number 5 to `/a` in the sandbox, and runs the same case through `simulate`.

## Expected

The sandbox and `simulate` both DENY, as production does (scenario r17 in Pyric's RTDB rules corpus records production denying this shape).

## Actual

On local-5 (exit 1):

```text
write 5 under .validate newData.val().toUpperCase() == 'A': sandbox DENY, simulate UNSUPPORTED (production DENY)
```

## Suspected cause

From the fix for 0018: the simulation handler (`packages/pyric/src/rules/rtdb/simulation/handler.ts`) returns an `EVALUATION_ERROR` for a rule that throws, which surfaces as UNSUPPORTED. The corpus replay treats any error as DENY, so the conformance run doesn't catch the difference. Separately, the doc comment on `RtdbCaseResult.matchedRule` says it holds the rule kind but it holds the rule expression.

## Suggested fix and failing test

Treat an evaluation error in a rule as that rule failing, which denies, as the sandbox does, and keep UNSUPPORTED for expressions Pyric cannot parse or evaluate by design. Make the corpus replay distinguish a DENY from an error so this can't hide again. Failing tests first: this repro's case in the simulation handler tests and in the sandbox agreement test added with the fix for 0018.

## Workaround in pyric-games

Check the type before calling a method (`newData.isString() && newData.val().toUpperCase() == 'A'`). Air Hockey's rules already check types first.
