---
id: 0025
title: In Storage rules, an upload over an existing object is evaluated as update in Pyric but as create in production, so a create-only rule denies the overwrite
severity: major
package: pyric
pyric_commit: 9c125203
found_in: fixing 0021 (a production capture of request.resource on real client writes)
status: open
---
## Summary

When a client uploads to a path that already holds an object, production evaluates the Storage rules for `create`, with `resource` still set to the stored object. Pyric evaluates the same upload as `update`. So a ruleset that allows `create` and denies `update` lets an overwrite through in production and denies it in Pyric, and a rule written to guard overwrites through `allow update` has no effect in production.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0025.ts
```

The script sets rules that allow `create` for the owner and deny `update`, then uploads to `users/alice/a.txt` twice as alice.

## Expected

Both uploads are allowed, because production evaluates both as `create`.

## Actual

On local-5 (exit 1):

```text
first upload: ALLOW (production ALLOW, evaluated as create)
upload over the existing object: DENY (production ALLOW, evaluated as create)
```

## Suspected cause

Confirmed by reading. `packages/pyric/src/storage/upload.ts:77-79`: the upload's rules request uses `method: existing ? 'update' : 'create'`. The production verdicts come from the real-bucket capture `stdlib-realstorage-request-resource-fields`, taken while fixing 0021; its replay test pins this divergence.

## Suggested fix and failing test

Evaluate every client upload as `create`, and keep `resource` bound to the stored object when one exists, as production does. Keep `update` for metadata updates. Failing tests first: this repro's two uploads, and a rule that reads `resource.size` on an overwrite (the stored size) against `request.resource.size` (the new size). The existing test in `packages/pyric/test/storage/enforce.test.ts` that asserts an overwrite is denied as an update pins Pyric's current behavior and changes with the fix. Update the Storage registry row the capture is linked to and unpin the divergence in the replay test.

## Workaround in pyric-games

Sokoban's move lists are create-only by design (each solve has a new object name), so the game never overwrites. A rule that must allow overwrites can grant them under `create` with a check on `resource == null` or on the stored object.
