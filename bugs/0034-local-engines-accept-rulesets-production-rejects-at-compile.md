---
id: 0034
title: The Firestore simulator and Storage evaluator accept rulesets production rejects at compile time (call depth 22, 12 let bindings, 98 nesting levels), and the Storage evaluator denies a 21-function chain production compiles
severity: minor
package: pyric
pyric_commit: 8b3c2c84
found_in: measuring production compile limits for the Firestore limits doc
status: open
---
## Summary

Production's compiler rejects a ruleset when one call stack holds 22 functions ("Maximum allowed call depth of 20 is reached"), when a function has 12 `let` bindings ("Maximum allowed variable count of 10 for a given function has been reached"), or when an expression nests too deep ("Expression is too complex to evaluate safely"): 98 parenthesized levels around a comparison, or 99 around a bare literal, which sits one level shallower. It compiles 21 functions, 11 bindings, 97 levels around a comparison and 98 around a literal. Pyric's Firestore simulator and Storage evaluator accept all four rejected shapes and allow the request, so a ruleset that passes every local test can fail to deploy. Separately, the Storage evaluator caps call depth at 20 and denies a 21-function chain production compiles and allows.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0034.ts
```

The script simulates a read under three rulesets: a 22-function call chain, a function with 12 `let` bindings, and a bare `true` wrapped in 99 parentheses.

## Expected

Each simulation reports the ruleset as rejected with production's compile error, and lint reports the same limits. A 21-function chain evaluates in both engines.

## Actual

On local-6 (exit 1):

```text
call stack of 22 functions: simulate ALLOW; production rejects the ruleset at compile time
function with 12 let bindings: simulate ALLOW; production rejects the ruleset at compile time
literal in 99 parentheses: simulate ALLOW; production rejects the ruleset at compile time
```

## Suspected cause

Neither engine checks compile limits; only lint does (CALL_DEPTH and LET_LIMIT, with no nesting check). `packages/pyric/src/storage/sandbox/rules-evaluator.ts` sets `MAX_CALL_DEPTH = 20` as a runtime guard, one below production's 21. The measured boundaries and error texts are in `packages/pyric/test/rules/linter/fixtures/compile-limits/captures.json` on Pyric main after the limits doc change.

## Suggested fix and failing test

Run the compile-limit checks when a ruleset is loaded into either engine and report production's error text through the existing parse-error path, so `simulate` and the sandbox refuse the ruleset the way a deploy would; raise the Storage runtime guard to 21 or remove it in favor of the compile check; add a nesting-depth lint keyed to the same fixture. Failing tests first: the three rejected shapes and the 21-function control, in the simulator tests and the Storage evaluator tests, reading the compile-limits fixture.

## Workaround in pyric-games

Keep call chains at 21 functions or fewer and `let` bindings at 11 or fewer; lint reports both. Run the resolved ruleset through the Rules Test API once before deploying.
