---
id: 0010
title: Lint's SEC-6 and SEC-3 walk a called function's return expression but not its let bindings, so data or auth read through a let is reported as unchecked
severity: minor
package: pyric
pyric_commit: 9c125203
found_in: Yacht rules lint (yachtCreate)
status: open
---
## Summary

`lint()` reports SEC-6 ("does not validate request.resource.data") for a create rule whose function binds `let d = request.resource.data;` and validates every field through `d`. SEC-3 ("does not check request.auth") has the same gap for `let uid = request.auth.uid;`. Both checks follow function calls transitively, but only into each function's `body` (its return expression), never into its `lets`. A function written in the let style the skill and the resolver support is flagged as an error, and `bun run lint` exits 1.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0010.ts
```

The script lints three one-function rulesets with `lint` from `pyric/rules`: the checks read directly, the same checks with `request.resource.data` bound by a `let`, and `request.auth` bound by a `let`.

In the arcade, `bun run lint` on the first draft of `games/yacht/yacht.rules`, where `yachtCreate()` began with `let d = request.resource.data;`:

```text
error SEC-6: create at /yacht/{matchId} does not validate request.resource.data
```

The message goes on to say any data shape is accepted.

## Expected

No SEC-3 or SEC-6 for any of the three: each rule checks `request.auth` and validates `request.resource.data`, through a let or not.

## Actual

On Pyric main 9c125203 (local-5):

```text
direct: no SEC-3 or SEC-6
dataThroughLet: SEC-6
authThroughLet: SEC-3
```

## Suspected cause

`packages/pyric/src/rules/grammar/FirestoreValidator.ts` at 9c125203:

- `referencesAuthTransitive` (line 292) and `referencesRequestDataTransitive` (line 314) recurse into `fns.get(e.name)!.body` (lines 300 and 321). `FunctionDef` carries the bindings separately as `lets: LetBinding[]` (`packages/pyric/src/rules/grammar/FirestoreAST.ts:69-76`), so an expression that only appears in a let value is never visited, and neither is a function called only from a let value.

## Suggested fix and failing test

Visit each let value as well as the body, in both walkers (a shared helper that yields `[...fn.lets.map((l) => l.value), fn.body]` keeps them in step):

```ts
const fn = fns.get(e.name)!;
if ([...fn.lets.map((l) => l.value), fn.body].some((x) => referencesRequestDataTransitive(x, fns, visited))) found = true;
```

A let whose value is unused would then count as a check; that is the same looseness the walkers already accept for a reference anywhere in the body, so it does not need a use analysis.

Failing test, next to the "transitive auth resolution (SEC-3 bug fix)" cases in `packages/pyric/test/rules/grammar/validator-bugbash.test.ts`: lint the `dataThroughLet` and `authThroughLet` rulesets from the repro and assert no SEC-6 and no SEC-3 findings; also a function that calls a helper only from a let value (`let ok = helper();`), where `helper` reads `request.resource.data`.

## Workaround in pyric-games

`yachtCreate()` in `games/yacht/yacht.rules` reads `request.resource.data` directly instead of through a let. The Yacht update functions bind `before` and `after` with lets too, but they are not flagged: each read `request.auth` directly, and each update rule in `app/firestore.modules.rules` starts with `request.resource.data.lastAction == ...`, which SEC-6 sees.
