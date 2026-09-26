---
id: 0001
title: Module resolution rejects a method called on a member of a let-bound value, such as doc.board.keys()
severity: major
package: pyric
pyric_commit: 92d52b02
found_in: tic-tac-toe rules
status: open
---
## Summary

A rules function that binds `let doc = request.resource.data` and then calls a method on a member of it (`doc.board.keys()`) fails module resolution with "has an unresolved projected receiver". The same expression written without the `let` resolves. Production accepts both. The failure blocks `pyric firestore rules resolve`, and the dev server at startup, for any modular ruleset using the pattern.

## Reproduction

```bash
bun bugs/repro/0001.ts
```

The script resolves one module twice through `resolveModules` from `pyric/rules/internal/node`:

```rules
export function gameCreate() {
  let doc = request.resource.data;
  return doc.board.keys().hasOnly(['c0r0']);   // rejected
}
export function gameCreate() {
  return request.resource.data.board.keys().hasOnly(['c0r0']);   // resolves
}
```

`doc.keys()` directly on the `let` value resolves; only a member access between the binding and the method call fails.

## Expected

Both forms resolve. `let` bindings are plain aliases in Rules.

## Actual

```text
Function 'gameCreate' requires unsupported method '.keys()' has an unresolved projected receiver for service 'cloud.firestore'
```

## Suspected cause

Unconfirmed. `packages/pyric/src/rules/modules/service-compatibility.ts:100-113`: when `sourceReceiverType(object, ctx)` returns nothing, the code walks member accesses down to the projection source and, if that source's type is `map`, `list` or `document`, reports an unresolved projected receiver. For `doc.board`, the walk reaches `doc`, a `let` binding. The receiver type of the member (`doc.board`) is unknown, but the binding's own type (`document`, from `request.resource.data`) is known, so the check refuses instead of treating the member's type as unknown and allowing the call. It looks like `sourceReceiverType` or `sourceProvenance` doesn't follow `let` bindings to their value before projecting.

## Suggested fix and failing test

Resolve `let` bindings to their bound expression before the projection walk, so `doc.board.keys()` is analyzed the same as `request.resource.data.board.keys()`. Failing test first, in `packages/pyric/test/rules/modules/service-compatibility.test.ts`: resolve a module whose function uses `let doc = request.resource.data; return doc.board.keys().hasOnly([...])` and expect success, next to the direct form.

## Workaround in pyric-games

`games/tictactoe/tictactoe.rules` writes `request.resource.data.board...` out in full instead of binding it with `let`.
