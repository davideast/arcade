---
id: 0006
title: Module resolution rejects Firestore's global string() and int() inside a module function
severity: major
package: pyric
pyric_commit: 92d52b02
found_in: uno rules
status: open
---
## Summary

Firestore rules provide global conversion functions such as `string()` and `int()` (production accepted `'c' + string(n)` in the 2026-09-25 capture `map-index-computed-keys`). Inside a rules module, the resolver rejects any call to them, because its list of functions a module may call directly holds only `exists`, `existsAfter`, `get` and `getAfter`. The main file can call them. Paths built from integers (`deck/$(string(i))`) and wildcard ids compared as numbers (`int(i) < 108`) are the common cases.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0006.ts
```

## Expected

`string()`, `int()` and the other global functions production supports (`float()`, `bool()`, `path()`) resolve inside a module the same as in the main file.

## Actual

```text
string() in a module: Function 'check' requires unsupported function 'string()' for service 'cloud.firestore'
int() in a module: Function 'check' requires unsupported function 'int()' for service 'cloud.firestore'
int() in the main file: resolves
```

## Suspected cause

Confirmed by reading. `packages/pyric/src/rules/modules/rules-capabilities.generated.ts:4`: `FIRESTORE_DIRECT_FUNCTIONS = ["exists", "existsAfter", "get", "getAfter"]`. `service-compatibility.ts:158` rejects any call whose name is neither a declared function nor in that list. The generator that writes `rules-capabilities.generated.ts` omits the global type-conversion functions.

## Suggested fix and failing test

Add the global functions production supports (at least `string`, `int`, `float`, `bool`, `path`, `debug`) to the generated capability set, from the same source the evaluator's builtins come from (`RULES_BUILTIN_FUNCTIONS` in `packages/pyric/src/rules/grammar/builtin-functions.ts` is a candidate). Failing test first in `packages/pyric/test/rules/modules/service-compatibility.test.ts`: a module function using `string(n)` and `int(i)` resolves for `cloud.firestore`.

## Workaround in pyric-games

`app/firestore.modules.rules` converts in the allow expressions and passes the results into the Uno module functions: `unoPlay(database, matchId, string(request.resource.data.lastCard))`, `unoDeckCreate(database, matchId, int(i))`.
