---
id: 0005
title: The "Test in Node" guide's first example imports getFirestore from the pyric-admin root instead of pyric-admin/firestore
severity: minor
package: site-docs
pyric_commit: 92d52b02
found_in: foundation (writing repro 0004)
status: open
---
## Summary

A documentation defect; the package is correct. `pyric-admin` follows the modular admin SDK: `getFirestore` is exported from `pyric-admin/firestore`, as in `firebase-admin/firestore`. The guide `packages/site-docs/src/content/ship/test-in-node.md` opens with `import { getFirestore } from 'pyric-admin';`, so its first example fails before any test runs.

## Reproduction

```bash
bun bugs/repro/0005.ts
```

The script runs the guide's import as written, then the modular import.

## Expected

The guide's example runs as written.

## Actual

```text
SyntaxError: Export named 'getFirestore' not found in module '.../node_modules/pyric-admin/dist/index.js'.
```

## Suspected cause

Confirmed by reading. The code blocks in `test-in-node.md` use the package root; the package's `exports` map correctly puts Firestore at `./firestore`.

## Suggested fix and failing test

Change the guide's import to `import { getFirestore } from 'pyric-admin/firestore';` (and check the guide's other blocks). Failing test first: a docs test, in the style of `packages/pyric/test/rules/modules/docs-examples.test.ts`, that extracts the guide's TypeScript examples and type-checks their imports against the published exports.

## Workaround in pyric-games

Repro scripts import from `pyric-admin/firestore`.
