---
id: 0004
title: An update written with a dotted field path is denied where the equivalent whole-map update is allowed
severity: major
package: pyric
pyric_commit: 92d52b02
found_in: tic-tac-toe browser check (forged writes)
status: open
---
## Summary

`update({ 'board.c1r1': 'host', lastMove: 'c1r1' })` and `update({ board: { ...board, c1r1: 'host' }, lastMove: 'c1r1' })` produce the same document, and production builds the same `request.resource.data` for both. In Pyric's sandbox the whole-map form is allowed and the dotted form is denied by the same rule. Seen through the web SDK (`updateDoc` in the browser, via `pyric()`) and through `pyric-admin` in Node, so it is in the shared sandbox, not one SDK surface.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0004.ts
```

The script uses `initializeSandbox()` from `pyric/sandbox` and `getFirestore` from `pyric-admin/firestore`, seeds `games/g1` and `games/g2` with `{ host, lastMove: '', board: { c0r0: '', c1r1: '' } }` as admin, sets this rule, and updates as `host-uid`:

```rules
allow update: if request.auth.uid == resource.data.host
  && resource.data.board[request.resource.data.lastMove] == ''
  && request.resource.data.board[request.resource.data.lastMove] == 'host'
  && request.resource.data.board.diff(resource.data.board).affectedKeys().hasOnly([request.resource.data.lastMove])
  && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['board', 'lastMove']);
```

## Expected

Both updates allowed, and both store `board.c1r1 = 'host'`.

## Actual

```text
whole-map update: allowed -> {"host":"host-uid","lastMove":"c1r1","board":{"c0r0":"","c1r1":"host"}}
dotted update 'board.c1r1': permission-denied
```

## Suspected cause

Unconfirmed. The stored result of a dotted update is built correctly by `applyUpdate` in `packages/pyric/src/firestore/sandbox/field-merge.ts` (dotted top-level keys become leaf paths), and batches project their after-state through the same function (`write-runtime.ts:164`, `computeProjectedUpdate`). The single-document update path that builds the rules request likely merges the incoming data some other way, for example a shallow spread that produces a top-level field named `"board.c1r1"`. That would make `board.diff(...)` empty (the placed cell appears unchanged) and add `"board.c1r1"` to the document diff, and either denies the rule above. Start at the rules request construction in `packages/pyric/src/firestore/sandbox/local-environment.ts` and find where `request.resource.data` is built for `update`.

## Suggested fix and failing test

Build `request.resource.data` for every update with `applyUpdate(existing, incoming)`, the same function the write uses, so the evaluated after-state is exactly the stored one. Failing test first: `bugs/repro/0004.ts` as a sandbox test (a dotted update allowed by a rule that inspects `request.resource.data.board[...]` and `diff().affectedKeys()`), plus the same case through the web SDK surface.

## Workaround in pyric-games

`packages/turn-net` writes whole-map updates (`tx.update(ref, nextDocument)`), never dotted paths.
