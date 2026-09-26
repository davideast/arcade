---
id: 0008
title: After a rules reload fails, modules the new source imports are never watched, so fixing them doesn't reload and stale rules stay live
severity: major
package: "@pyric/cli"
pyric_commit: 92d52b02
found_in: uno (adding uno.rules to the arcade's modular ruleset under vite dev)
status: open
---
## Summary

The dev server watches the rules source and the module files of the last *successful* resolution. When a save adds an import whose module fails to resolve, the reload is rejected (correctly: last-good rules stay live), but the new module is not added to the watch set either. Fixing the module then produces no reload at all. The page keeps running the old rules, which here had no `match` block for the new collection, so every write to it was denied with no hint why. Saving the main file again is the only way out.

## Reproduction

From the repository root:

```bash
bash bugs/repro/0008.sh
```

The script starts `vite` with `pyric()` in a scratch app, imports a new module `b.rules` that fails resolution, fixes `b.rules`, and finally touches the main file, counting `rules reloaded` lines after each step.

## Expected

Saving the fixed `b.rules` reloads the rules.

## Actual

No reload after fixing `b.rules`; one reload only after the main file is touched:

```text
  ↻ [pyric] rules reloaded (<hash>)
reloads after fixing b.rules: 0; after touching the main file: 1
```

It happened again adding pool: the first save of `games/pool/pool.rules` failed resolution (bug 0001), three later fixes to that module produced no reload, and the dev server kept serving rules without a `/pool` match block until the main file was touched.

## Suspected cause

Confirmed by reading. `packages/cli/src/serve/vite-generation-rules-watch.ts`: files are added to Vite's watcher only from `session.firestoreRulesFiles()`, at startup and after a `reloaded` result. `SandboxSession.firestoreRulesFiles()` (`packages/cli/src/serve/sandbox-session.ts`) returns the module files of the last successful `prepareProjectRules`, and a rejected reload leaves them unchanged. `pyric dev`'s `watchRulesFiles` in `packages/cli/src/cli/serve.ts` syncs the same way, only on `reloaded`. The #766 PR notes this as intended ("A reload that fails keeps the last good rules and the current watch set"), but it leaves the fix-the-module loop broken.

## Suggested fix and failing test

On a rejected reload, still watch every relative module the failed source names: parse the imports (the resolver already walks them before failing) and add their files to the watch set, or have the resolver report the module files it read even on failure. Failing test first in `packages/cli/test/serve/vite-generation-rules-watch.test.ts`: a reload that is rejected, with the session reporting a new module file for the failed source; a later change to that module file must trigger `reloadFirestoreRules`.

## Workaround in pyric-games

After fixing a module that broke a reload, save `app/firestore.modules.rules` (or `touch` it).
