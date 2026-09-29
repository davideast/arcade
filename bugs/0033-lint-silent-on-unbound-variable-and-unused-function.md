---
id: 0033
title: Lint reports nothing for an unbound variable or an unused function, both of which production's compiler warns about
severity: minor
package: pyric
pyric_commit: dbc35150
found_in: verifying the chess showcase rules against the Rules Test API
status: fixed
fixed_in: eb748488 (#813, 54313778)
---
## Summary

Production's compiler reports an unbound variable as a warning ("Invalid variable name: d.") and reports unused functions; at runtime the unbound variable is an error, so every request that reaches it is denied. Pyric's `lint` reports neither. The chess showcase shipped an `allow create` that read `d` without binding it, so creating a game was always denied, and lint on the resolved ruleset said nothing about it.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0033.ts
```

The script lints a ruleset with an `allow create` that reads `d.a1` with no `let d` and a function nothing calls.

## Expected

One finding for the unbound variable, at error severity since the rule can never allow, and one for the unused function.

## Actual

On local-6 (exit 1):

```text
unbound variable d: no finding
unused function neverCalled: no finding
```

## Suspected cause

`FirestoreValidator.ts` resolves function names (SEM-4) but not variable names: an identifier that is not a `let` binding, a path capture, a function parameter, or a global is accepted. Unused-function detection exists for some shapes (the existing tests mention an unused function finding) but did not fire on a match-scope function declared outside the match that holds the rules.

## Suggested fix and failing test

Resolve every identifier against the scopes in effect (globals, path captures, function parameters, `let` bindings) and report an unresolved one as an error-severity SEM finding; report a function no rule or function calls as a QUA finding at every scope. Failing tests first in the validator tests: this repro's two cases, plus a positive case where a `let` and a path capture resolve.

## Workaround in pyric-games

Run the resolved ruleset through the Rules Test API once per change; its compile warnings list both.

## Fixed

Fixed by Pyric PR #813, merged as 54313778, and verified on Pyric main eb748488 (vendored as local-7). Lint resolves function and variable names by declaration scope. `bun bugs/repro/0033.ts` exits 0: the unbound variable is reported as SEM-5 and the unused function as QUA-4.

Nothing to drop in the arcade: `bun run lint` reports neither finding for the arcade rules.
