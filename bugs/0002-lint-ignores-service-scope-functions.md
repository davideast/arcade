---
id: 0002
title: Rules lint reports zero functions and zero estimated expressions for resolved modular rules, because it skips service-scope functions
severity: major
package: pyric
pyric_commit: 92d52b02
found_in: tic-tac-toe rules lint
status: open
---
## Summary

`pyric firestore rules resolve` writes imported functions at service scope (`service cloud.firestore { function f() {...} match ... }`). The linter only collects functions inside match blocks, so for every resolved modular ruleset it reports `functionCount: 0` and `maxEstimatedExpressions: 0`, and its chain-depth, let-binding and runtime-budget checks never look at those functions. A modular ruleset that would exceed the production expression budget lints clean.

## Reproduction

```bash
bun bugs/repro/0002.ts
```

The script lints the same one-function ruleset twice with `lintFirestoreRules` from `pyric/rules/internal`: once with the function in the `match /databases/...` block, once at service scope (the shape the resolver writes).

Also visible end to end: `bun run rules:resolve` in `app/`, then `pyric rules lint --service firestore` there prints `"functionCount": 0` for a ruleset with 21 functions.

## Expected

`functionCount: 1` for both, and the same warnings for a function wherever it is declared (global, service, or match scope).

## Actual

```text
function in match block:  functionCount 1 maxEstimatedExpressions 0
function at service scope: functionCount 0 maxEstimatedExpressions 0
```

## Suspected cause

Confirmed by reading. `packages/pyric/src/rules/linter/linter.ts:830`: `const allFunctions = collectAllFunctions(ast.service.match);` walks only the match tree. `ast.service.functions` (service scope) and `ast.functions` (global scope) are never included, so every rule computed from `allFunctions` (chain depth at 834, let bindings, call depth, runtime budget, `functionCount` at 917) skips them.

## Suggested fix and failing test

Collect `[...(ast.functions ?? []), ...(ast.service.functions ?? []), ...collectAllFunctions(ast.service.match)]`, and resolve calls from allow conditions against all three scopes when estimating expressions. Failing test first in `packages/pyric/test/rules/linter/`: a ruleset whose only function is at service scope and has a 99-term `&&` chain must report `CHAIN_DEPTH_LIMIT`, and `functionCount` must be 1.

## Workaround in pyric-games

None. Lint output on resolved rules is ignored; the rules harness and removal probes are the checks.
