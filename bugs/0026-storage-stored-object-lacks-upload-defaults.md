---
id: 0026
title: Storage stores an upload without production's contentDisposition and contentEncoding defaults, so getMetadata and a metadata update's rules see them unset
severity: minor
package: pyric
pyric_commit: 9c125203
found_in: fixing 0021 (a production capture of request.resource on real client writes)
status: fixed
fixed_in: dbc35150 (#792, eb498e87)
---
## Summary

When an upload sets no `contentDisposition` or `contentEncoding`, production stores `inline; filename*=utf-8''<file>` and `identity`. Pyric stores neither. `getMetadata` returns them unset, and a metadata update's `request.resource` (and the stored `resource`) carry null for them, where production carries the stored defaults. A rule that checks either field on update denies in Pyric and allows in production.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0026.ts
```

The script uploads `users/alice/a.txt` with only a contentType, reads its metadata, then updates its custom metadata under a rule that requires `request.resource.contentEncoding == 'identity'`.

## Expected

`getMetadata` returns `contentDisposition: "inline; filename*=utf-8''a.txt"` and `contentEncoding: "identity"`, and the metadata update is allowed.

## Actual

On local-5 (exit 1):

```text
stored contentDisposition: undefined (production "inline; filename*=utf-8''a.txt")
stored contentEncoding: undefined (production "identity")
metadata update requiring request.resource.contentEncoding == 'identity': DENY (production ALLOW)
```

The update also fails on local-5 because of 0021 (`request.resource` had no contentEncoding at all); on Pyric main after the 0021 fix, the upload's `request.resource` carries the defaults but the stored record still doesn't, so the update still denies.

## Suspected cause

Confirmed by reading. `packages/pyric/src/storage/upload.ts:173-174`: the stored record takes `contentDisposition` and `contentEncoding` from the caller's settable metadata only. The 0021 fix applies the defaults to the upload's `request.resource` binding but not to the record it stores.

## Suggested fix and failing test

Apply the same defaults when the upload's record is stored (one helper shared with the `request.resource` binding), so `getMetadata`, `resource` and a metadata update's `request.resource` agree with production. Failing tests first: this repro, plus `getMetadata` after an upload that sets both fields explicitly (kept as set). Confirm production's default for a file name that needs percent-encoding before relying on it; only a plain ASCII name has been captured.

## Workaround in pyric-games

None needed: the arcade's Storage rules don't read either field.

## Fixed

Fixed by Pyric PR #792, merged as eb498e87, and verified on Pyric main dbc35150 (vendored as local-6). Storage now stores an upload with production's `contentDisposition` and `contentEncoding` defaults. `bun bugs/repro/0026.ts` exits 0: the stored values match production and the metadata update is allowed.

Nothing to drop in the arcade: its Storage rules don't read either field.
