---
id: 0039
title: The resolved ruleset's source map names `firestore.rules` as the file of the root file's `service` line and of the `let` bindings in its functions
severity: minor
package: pyric
pyric_commit: eb748488
found_in: moving the arcade's Storage rules to a 2+modules source
status: open
---
## Summary

`pyric firestore rules resolve` and `pyric storage rules resolve` write a `// @pyric-source-map:` line that maps each generated line back to its authored file and line. For the root file (the file passed to resolve), two kinds of line name `firestore.rules` as their file instead of the root file's name: the `service` line, and each `let` binding in a function the root file declares. The other root lines (match blocks, functions, allow rules) name the root file, and module lines name their module. A Storage ruleset gets `firestore.rules` too. The line numbers are right; only the file is wrong.

The simulator reads this map to cite authored locations, so a citation on one of these lines points at a file that does not exist in a project that authors `firestore.modules.rules` or `storage.modules.rules`.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0039.ts
```

The script resolves a Firestore and a Storage `2+modules` source, each with a root function that has a `let`, and checks every source-map entry for the root file.

## Expected

Every root-file entry names the root file: `firestore.modules.rules` or `storage.modules.rules`.

## Actual

On local-7 (Pyric main eb748488), exit 1:

```text
firestore.modules.rules: generated line 2 "service cloud.firestore {" -> firestore.rules:3 (expected firestore.modules.rules)
firestore.modules.rules: generated line 8 "let uid = request.auth.uid;" -> firestore.rules:6 (expected firestore.modules.rules)
storage.modules.rules: generated line 2 "service firebase.storage {" -> firestore.rules:3 (expected storage.modules.rules)
storage.modules.rules: generated line 8 "let uid = request.auth.uid;" -> firestore.rules:6 (expected storage.modules.rules)
```

The arcade's resolved `app/storage.rules` shows the same: its `service` line and the two `let` lines of `sokobanUpload` map to `firestore.rules`.

## Suspected cause

`attachAstSourceFile` in `packages/pyric/src/rules/modules/resolver-core.ts` sets `loc.file` on functions, match blocks and allow rules, but not on the service node or on each function's `lets`. `recordSourceLoc` in `packages/pyric/src/rules/grammar/FirestoreAssembler.ts` falls back to `'firestore.rules'` for a location with no file, whatever the service.

## Suggested fix and failing test

Set `loc.file` on the service node and on every `let` binding (root, service-scope and match-scope functions) in `attachAstSourceFile`, and drop the `'firestore.rules'` fallback in `recordSourceLoc` in favor of the file the resolver passes. Failing tests first: resolve a Firestore and a Storage `2+modules` source whose root function has a `let`, and assert that every source-map entry for a root line names the root file.

## Workaround in pyric-games

None needed. Nothing in the arcade reads the source map.
