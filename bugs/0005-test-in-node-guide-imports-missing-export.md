---
id: 0005
title: The "Test in Node" guide imports getFirestore from 'pyric-admin', which does not export it
severity: minor
package: pyric-admin
pyric_commit: 92d52b02
found_in: foundation (writing repro 0004)
status: open
---
## Summary

`packages/site-docs/src/content/ship/test-in-node.md` opens with `import { getFirestore } from 'pyric-admin';`. The package root does not export `getFirestore`; it lives at `pyric-admin/firestore`. The guide's first example fails before any test runs.

## Reproduction

```bash
bun bugs/repro/0005.ts
```

## Expected

The guide's imports resolve as written.

## Actual

```text
SyntaxError: Export named 'getFirestore' not found in module '.../node_modules/pyric-admin/dist/index.js'.
```

## Suspected cause

Confirmed by reading. The guide's code block at the top of `test-in-node.md` imports from the package root; `pyric-admin`'s `exports` map puts Firestore at `./firestore` (`packages/pyric-admin/package.json`), matching `firebase-admin/firestore`.

## Suggested fix and failing test

Change the guide's import to `import { getFirestore } from 'pyric-admin/firestore';`. Failing test first: a docs test like `packages/pyric/test/rules/modules/docs-examples.test.ts` that extracts the TypeScript examples from `test-in-node.md` and type-checks their imports against the published exports.

## Workaround in pyric-games

Repro scripts import from `pyric-admin/firestore`.
