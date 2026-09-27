---
id: 0023
title: rules lint and rules simulate for the Realtime Database reject a database.rules.json with comments as "not valid JSON", while database rules validate accepts it
severity: minor
package: "@pyric/cli"
pyric_commit: 9c125203
found_in: reviewing the fix for 0015
status: open
---
## Summary

A Realtime Database rules file may carry `//` comments, and `pyric database rules validate` strips them before parsing. `pyric rules lint --service database` and `pyric rules simulate --service database` read the same file with plain `JSON.parse`, so one comment line makes them reject the file as "not valid JSON" and exit 2. The three commands disagree on the same file, and the two that reject it are the ones an agent or CI step uses to gate a change.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0023.ts
```

The script writes a `database.rules.json` with one comment line and per-user notes rules, then runs `pyric database rules validate` and `pyric rules lint --service database --rules-file` on it.

## Expected

Both commands accept the file and report its findings (none here); both exit 0.

## Actual

On local-5 (exit 1):

```text
database rules validate: exit 0 "errors": []
rules lint --service database: exit 2 The supplied database rules are not valid JSON. Pass rules as a JSON object with a 'rules' key.
```

## Suspected cause

Confirmed by running and reading. `packages/cli/src/bridge/surface/rules-engines/database.ts:19-21`: `parseRuleset` calls `JSON.parse(source)`, and line 76 parses the same way for another path. `packages/cli/src/cli/database-rules.ts:40` parses with `JSON.parse(stripJsonComments(raw))`, using `stripJsonComments` from `packages/cli/src/rtdb/rules-json.ts`.

## Suggested fix and failing test

Parse RTDB rules text in one place with `stripJsonComments` and use it for lint, simulate and validate, so every command accepts the same files. Failing tests first in `packages/cli/test/bridge/surface/rules-engines/database.test.ts` and `packages/cli/test/cli/surface-method-runner.test.ts`: lint and simulate on a rules file with `//` and `/* */` comments return the same result as the file without them. Whether production accepts comments in deployed RTDB rules is not recorded in Pyric's conformance data; capture it when fixing, and record it in the RTDB registry.

## Workaround in pyric-games

Keep `database.rules.json` free of comments. Air Hockey generates the file from TypeScript with `JSON.stringify`, so it has none.
