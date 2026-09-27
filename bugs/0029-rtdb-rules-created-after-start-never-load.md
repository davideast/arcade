---
id: 0029
title: The dev server never loads a database.rules.json created after it starts, so RTDB stays deny-all until a restart
severity: major
package: "@pyric/cli"
pyric_commit: 9c125203
found_in: playing Air Hockey on a dev server started before the branch added app/database.rules.json
status: open
---
## Summary

`pyric()` reads `database.rules.json` once when the dev server starts. If the file doesn't exist then, the server records no rules path, the rules watcher never matches the file, and a file created later is never loaded. The Realtime Database stays deny-all for the life of the server. Air Hockey showed it: a dev server started before the branch that added `app/database.rules.json` denied the host's first live write, so the game stopped at "Opening the table." while every guest mallet write raised "The rules denied that move". Changing a file that existed at startup does reload.

## Reproduction

From the repository root:

```bash
bash bugs/repro/0029.sh
```

The script starts a Vite server with `pyric()` in a directory with Firestore rules and no `database.rules.json`, creates `database.rules.json` after startup, waits, and checks the server log for an RTDB rules reload.

## Expected

The server notices the new file and loads it (`rtdb rules reloaded`), as it does when an existing file changes.

## Actual

On local-5 (exit 1):

```text
no database.rules.json found, client RTDB reads/writes default to DENY (matching production Firebase). Use --permissive for open prototyping.
creating database.rules.json after startup: never loaded (RTDB stays deny-all)
```

## Suspected cause

Confirmed by reading. `packages/cli/src/serve/vite-generation-rules-watch.ts:18-23` captures `session.summary.rules.database.sourcePath` once; when it is null, `hasDatabaseFile` is false and `onRulesChange` never matches the database file (and when neither rules file exists the watcher returns null). `reloadDatabaseRules` in `packages/cli/src/serve/sandbox-session.ts` already sets `database.sourcePath` from a fresh load, but nothing calls it for a file that was missing at startup. `pyric dev` (`packages/cli/src/cli/serve.ts:567`) captures the path the same way.

## Suggested fix and failing test

Watch the path the rules would load from (`firebase.json`'s `database.rules`, or `database.rules.json` in the project), whether or not it exists at startup, and reload on `add` as well as `change`, for Firestore, RTDB and Storage rules alike; the missing-file watch added for rules modules (a watch on the nearest existing ancestor) shows the shape. Failing tests first in the Vite rules watch tests and the `pyric dev` watch tests: a server started without the file loads it when it's created, and a deleted file returns RTDB to deny-all with a notice.

## Workaround in pyric-games

Restart the dev server after switching to a branch that adds `app/database.rules.json`, or after the first `bun run rtdb:rules`.
