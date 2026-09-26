---
id: 0001
title: In a rules module, a method call on a field of a get() or getAfter() document, or of a let or parameter bound to one, is rejected by module resolution
severity: blocker
package: pyric
pyric_commit: 92d52b02
found_in: tic-tac-toe rules, then uno and pool rules
status: open
---
## Summary

Module resolution rejects a method call on a field of any document the compatibility analysis can't type: a `let` binding, a `get()` or `getAfter()` result, or a function parameter that receives one. `get(path).data.members.hasAny([...])` and `getAfter(path).data.players.size()` are ordinary Rules; production accepts them, and the same expressions resolve when written against `resource.data`. The failure stops `pyric firestore rules resolve` and the dev server at startup for any modular ruleset that reads another document's lists or maps, which covers membership checks, parent-document gates, and every multi-document game rule.

## Reproduction

```bash
bun bugs/repro/0001.ts
```

## Expected

Every case resolves; only `resource.data.players.size()` does today.

## Actual

```text
resource.data.players.size() (control): resolves
let doc = request.resource.data; doc.board.keys(): Function 'check' requires unsupported method '.keys()' has an unresolved projected receiver for service 'cloud.firestore'
get(...).data.players.size(): Function 'check' requires unsupported method '.size()' has an unresolved projected receiver for service 'cloud.firestore'
getAfter(...).data.players.size(): Function 'check' requires unsupported method '.size()' has an unresolved projected receiver for service 'cloud.firestore'
parameter bound to get(...).data: Function 'm__count' requires unsupported method '.size()' has an unresolved projected receiver for service 'cloud.firestore'
parameter bound to request.resource.data.shot, shot.keys(): Function 'm__valid' requires unsupported method '.keys()' requires map receiver, got unknown for service 'cloud.firestore'
```

The last case is a second shape with its own message: a helper that takes a map field of the incoming document (`valid(request.resource.data.shot)`) can't call a map-only method on it. The call-site analysis types the argument as `unknown`, and a method that exists only on maps (`keys()`, `values()`, `diff()`) is refused for an `unknown` receiver instead of being allowed or checked at run time. Found writing pool's shot validation.

## Suspected cause

Unconfirmed in detail. `packages/pyric/src/rules/modules/service-compatibility.ts:100-113`: when `sourceReceiverType(object, ctx)` returns nothing for the method's receiver (`doc.board`, `get(...).data.players`), the code walks member accesses down to the projection source, and if that source's type is `map`, `list` or `document` it reports "an unresolved projected receiver". A field of a document has an unknown type by nature, so a known document type at the root should allow the call (or check it against every receiver type the method supports), not refuse it. `resource.data` escapes because its fields are typed through a different provenance path. The call-site analysis (`resolver-call-sites.ts`) carries the document type into parameters, which is why passing the document into a helper fails the same way.

## Suggested fix and failing test

Treat a method on an untyped field of a known document as allowed when the method exists on any Firestore receiver type (or defer to the evaluator), instead of rejecting it. Failing tests first in `packages/pyric/test/rules/modules/service-compatibility.test.ts`: each case in `bugs/repro/0001.ts` resolves.

## Workaround in pyric-games

Tic-tac-toe writes `request.resource.data.board...` out in full instead of binding it. Uno keeps a `size` field on the match (enforced equal to `players.size()` by the join rule) so the subcollection rules read `get(...).data.size` instead of calling `.size()`.

Pool validates the shot map with `request.resource.data.shot` written out in full inside `poolShotBasics` rather than passing it to a helper, and calls `poolNewly()` at each use instead of passing the newly pocketed set as a parameter (a set parameter is typed `unknown` the same way, so `.size()` on it is refused).
