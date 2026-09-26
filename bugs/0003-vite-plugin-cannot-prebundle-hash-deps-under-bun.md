---
id: 0003
title: Under Bun workspaces, pyric() cannot pre-bundle js-md5 and js-sha256, and the page fails to load
severity: blocker
package: "@pyric/cli"
pyric_commit: 92d52b02
found_in: foundation (first vite dev run)
status: fixed
fixed_in: 87a5303e (#770, b4debe01)
---
## Summary

The `pyric()` Vite plugin adds `optimizeDeps.include: ['js-md5', 'js-sha256']`. Those are dependencies of `pyric`, not of the app. In a Bun workspace (isolated installs), neither package is resolvable from the app's root, so Vite skips pre-bundling them, serves the CommonJS source to the browser, and Pyric's page runtime throws on its named import. The app shows a blank page.

## Reproduction

From the repository root:

```bash
bash bugs/repro/0003.sh
```

The script builds a fresh minimal Bun workspace in a temp directory (one app with `vite.config.ts` = `plugins: [pyric()]`, one `firebase/app` import), installs the vendored Pyric tarballs, starts Vite, requests the page, and checks Vite's log.

In the browser (seen in pyric-games before the workaround), the console shows:

```text
Uncaught SyntaxError: The requested module '/@fs/.../node_modules/.bun/js-md5@0.8.3/node_modules/js-md5/src/md5.js?v=...' does not provide an export named 'md5'
```

## Expected

The plugin pre-bundles its own runtime dependencies regardless of the package manager's layout, and the page loads.

## Actual

```text
Failed to resolve dependency: js-md5, present in client 'optimizeDeps.include'
Failed to resolve dependency: js-sha256, present in client 'optimizeDeps.include'
```

## Suspected cause

Confirmed by reading. `packages/cli/src/serve/vite-module-swap.ts:164`: `include: ['js-md5', 'js-sha256']` uses bare specifiers, which Vite resolves from the project root. With hoisted installs (npm, pnpm with hoisting) they happen to resolve; with Bun's isolated layout they only exist under `node_modules/.bun/.../pyric/node_modules`.

## Suggested fix and failing test

Use Vite's nested-dependency form so the lookup starts from the package that depends on them, for example `include: ['@pyric/cli > pyric > js-md5', '@pyric/cli > pyric > js-sha256']`, or resolve their paths from `pyric`'s own location with `createRequire`. Failing test first: extend the install matrix (`scripts/install-matrix.sh`, bun lane) or the packed Vite fixture so it serves the page and fails on `Failed to resolve dependency`; `bugs/repro/0003.sh` is the shape.

## Workaround in pyric-games

The root `package.json` lists `js-md5` and `js-sha256` under `optionalDependencies`, so they are linked at the workspace root, where Vite finds them.

## Fixed

Fixed by Pyric PR #770, merged as b4debe01, and verified on Pyric main 87a5303e (vendored as local-4). `bash bugs/repro/0003.sh` exits 0: the rules hashing functions no longer depend on js-md5 or js-sha256, so there is nothing to pre-bundle.

Dropped in f6c7064: the root `optionalDependencies` for js-md5 and js-sha256 are removed.
