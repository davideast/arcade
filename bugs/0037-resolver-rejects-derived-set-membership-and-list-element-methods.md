---
id: 0037
title: Module resolution rejects membership in a set built from request data, and a method on an element of a list built from request data
severity: major
package: pyric
pyric_commit: 8b3c2c84
found_in: restructuring the Reversi move rule to fit production's expression budget
status: fixed
fixed_in: eb748488 (#817, 9f30fe36)
---
## Summary

In a `2+modules` ruleset, a module function that tests `x in s`, where `s` is a set computed from request or resource data (`request.resource.data.board.diff(resource.data.board).affectedKeys()`), fails to resolve with "requires unsupported binding '<derived ambient value>'". A method called on an element of a list computed from request data (`request.resource.data.at.split('_')[0].split('-')`, or a literal string split by a request value and indexed) fails with "requires unsupported binding '<derived ambient receiver>'". Production evaluates all of these; the split forms were checked with the Rules Test API on digame-mas as plain rules.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0037.ts
```

The script resolves one module function per case: membership in a literal set and `concat()` on a request list as controls, then the three rejected forms.

## Expected

Every case resolves.

## Actual

On local-6 (exit 1):

```text
'k' in ['k'].toSet() (control): resolves
element in a.diff(b).affectedKeys(): Function 'check' requires unsupported binding '<derived ambient value>' for service 'cloud.firestore'
method on an element of a split: s.split('_')[0].split('-'): Function 'check' requires unsupported binding '<derived ambient receiver>' for service 'cloud.firestore'
method on an element of a literal split by a request value: 'a_b c'.split(at)[1].split(' '): Function 'check' requires unsupported binding '<derived ambient receiver>' for service 'cloud.firestore'
request.resource.data.list.concat([1]).size() (control): resolves
```

## Suspected cause

`packages/pyric/src/rules/modules/service-compatibility.ts`: `ambientMembershipIssue` returns an issue whenever the collection's provenance is `'unknown-ambient'`, and `ambientMethodReceiverIssue` does the same when the receiver's type is unknown. `source-expression-analysis.ts` marks any method result with an ambient receiver or argument as `'unknown-ambient'`, and an index into such a list has no receiver type. The file's own comment says an unknown receiver type is not checked, since production makes a method on the wrong type an evaluation error. Pyric main 8b3c2c84 has the same code.

## Suggested fix and failing test

For `cloud.firestore`, accept membership in and methods on derived values whose root bindings are all accepted for the service; keep the check for bindings the service does not have. Failing tests first in the resolver's service-compatibility tests: the three rejected cases above resolve for Firestore, and a derived value rooted in a Storage-only binding is still rejected.

## Workaround in pyric-games

The Reversi move rule indexes the rays table with the move's square, which the analysis does not mark as derived, and tests sets with `hasAll` and `hasAny` instead of `in`.

## Fixed

Fixed by Pyric PR #817, merged as 9f30fe36, and verified on Pyric main eb748488 (vendored as local-7). Module resolution accepts membership in a set built from request data and a method on an element of a list built from request data. `bun bugs/repro/0037.ts` exits 0: every case resolves.

Nothing to drop in the arcade: the Reversi move rule does not depend on either form.
