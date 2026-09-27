---
id: 0021
title: In Storage rules, `request.resource` has only size, contentType and metadata; reading `request.resource.name` or `.bucket` errors and denies
severity: major
package: pyric
pyric_commit: 9c125203
found_in: Sokoban (the upload rule ties the uploaded object to the path the score document names)
status: fixed
fixed_in: dbc35150 (#787, a7c6ac4a)
---
## Summary

For a write, Pyric builds `request.resource` with three fields: `size`, `contentType` and `metadata`. The stored `resource` binding also carries `name`, `bucket`, `timeCreated`, `updated`, `generation` and `metageneration`, derived from the same persisted record. The Storage rules reference (https://firebase.google.com/docs/reference/security/storage) documents `request.resource` with the same fields as `resource`. So a rule that reads `request.resource.name` or `request.resource.bucket` gets an absent-property error, and the rule denies.

Pyric has no production capture of these fields on `request.resource`. `packages/conformance/rules-language/storage.json` has constructs for `request.resource.size`, `.contentType` and `.metadata` only, while it has `resource.name`, `.bucket`, `.timeCreated`, `.updated`, `.generation` and `.metageneration`, with `resource.name` and `resource.bucket` captured by `rules-storage-resource-object-identity`.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0021.ts
```

Alice uploads `users/alice/a.txt` (2 bytes, `text/plain`) under `match /b/{bucket}/o { match /users/{uid}/{file} }` with one `allow create` condition per case. The last case is a control on the fields Pyric does build.

## Expected

```text
request.resource.name == 'users/alice/a.txt': ALLOW
request.resource.name.split('/')[1] == request.auth.uid: ALLOW
request.resource.bucket == bucket: ALLOW
request.resource.name != 'users/alice/a.txt': DENY
request.resource.size == 2 && request.resource.contentType == 'text/plain': ALLOW
```

## Actual

Exit code 1:

```text
request.resource.name == 'users/alice/a.txt': DENY (expected ALLOW)
request.resource.name.split('/')[1] == request.auth.uid: DENY (expected ALLOW)
request.resource.bucket == bucket: DENY (expected ALLOW)
request.resource.name != 'users/alice/a.txt': DENY (expected DENY)
request.resource.size == 2 && request.resource.contentType == 'text/plain': ALLOW (expected ALLOW)
```

The deny reason for the first case ends in `match /users/{uid}/{file} create: Property name is undefined on object..` The `!=` case denies for the same error, not because the comparison is false.

## Suspected cause

Confirmed by reading. `requestResourceFor` in `packages/pyric/src/storage/sandbox/rules-resources.ts:83-93` takes `size`, `contentType` and `customMetadata` and returns only those three fields. Its type, `StorageRequest['resource']` in `packages/pyric/src/storage/sandbox/rules.ts:159`, has only those three. In the same file, `resourceFromStored` (`rules-resources.ts:18-41`) derives `name` with `objectNameFromFullPath` (`rules-resources.ts:54-67`) and passes `bucket`, the times and the generations through. `buildRequestObject` (`packages/pyric/src/storage/sandbox/rules-bindings.ts:60`) passes `request.resource` to the evaluator as built, and the evaluator's `readProperty` (`packages/pyric/src/storage/sandbox/rules-evaluator.ts:161-171`) returns `Property name is undefined on object.` for the missing key.

Both write paths call it with three fields: `uploadBytes` in `packages/pyric/src/storage/upload.ts:81-85`, although the `stored` record it passes from already has `fullPath` and `bucket` (`buildStoredMetadata`, `upload.ts:153-183`), and `updateMetadata` in `packages/pyric/src/storage/metadata.ts:238-240`.

## Suggested fix and failing test

Capture first: add a Storage corpus scenario under `packages/conformance/rules-corpus/storage/` that reads `request.resource.name`, `.bucket`, `.timeCreated`, `.updated`, `.generation` and `.metageneration` on a create and on an update, run it against the Rules Test API, and add the constructs that production supports to `packages/conformance/rules-language/storage.json` with a registry row in `packages/conformance/registry/rules.ts`. Then pass the object path and bucket through from the upload path (`upload.ts`, and `metadata.ts` for metadata updates) into `requestResourceFor`, reuse `objectNameFromFullPath` for `name`, widen `StorageRequest['resource']` to the fields the capture shows, and convert the time fields to timestamps in `buildRequestObject` the way `buildResourceObject` does. Failing test: the repro's cases in `packages/pyric/test/storage/sandbox/rules-resources.test.ts` (for the binding) and `packages/pyric/test/storage/enforce.test.ts` (for an upload through the SDK).

## Workaround in pyric-games

`app/storage.rules` reads the object's identity from the match path instead of `request.resource`. `match /sokoban/{uid}/{level}/{file}` calls `sokobanUpload(uid, level, file)`, which checks `request.auth.uid == uid`, `meta.level == level`, and `score.object.split('/')[3] == file`, where `score` is the owner's score document for that level read with `firestore.get()`. The Firestore rules fix `score.object` to `sokoban/{uid}/{level}/{solve}-{moves}-{pushes}.txt`, so the path variables together with that check stand in for `request.resource.name == score.object`. The rule never reads `request.resource.name` or `request.resource.bucket`.

## Fixed

Fixed by Pyric PR #787, merged as a7c6ac4a, and verified on Pyric main dbc35150 (vendored as local-6). `request.resource` in Storage rules now has `name` and `bucket`. `bun bugs/repro/0021.ts` exits 0: all five cases match their expected verdicts.

Workaround dropped: Sokoban's upload rule checks `request.resource.name == score.object` instead of the file name from the match path, and `sokobanUpload` no longer takes the file.
