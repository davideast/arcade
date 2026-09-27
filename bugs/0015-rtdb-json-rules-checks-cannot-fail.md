---
id: 0015
title: Checks on a Realtime Database rules JSON file can't fail; lint reports nothing for a rule that doesn't parse, and `database rules validate` exits 0 with errors
severity: major
package: pyric, @pyric/cli
pyric_commit: 9c125203
found_in: Air Hockey (running the guide's CLI checks on the generated database.rules.json)
status: fixed
fixed_in: dbc35150 (#782, e88388ba)
---
## Summary

The "Write Realtime Database rules in TypeScript" guide says the CLI's `rules lint --service database`, `database rules validate` and `rules simulate --service database` "run the same checks against the JSON file, so CI can gate on them without TypeScript in the loop". They can't gate: for a rules file whose expression doesn't parse, `rtdbRules(json).lint()` returns no issues, `pyric rules lint --service database` prints `0 findings, 0 errors` and exits 0, and `pyric database rules validate` prints the PARSE_ERROR but exits 0. The same rule in a TypeScript definition lints as an error.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0015.ts
```

The script writes `{ "rules": { "notes": { "$id": { ".write": "auth != null && (" } } } }` to a temporary file and checks it four ways.

## Expected

Each check reports the PARSE_ERROR as an error, and both CLI commands exit non-zero.

## Actual

```text
rtdbRules(definition).lint(): error PARSE_ERROR
rtdbRules(json).lint(): no issues
pyric database rules validate: exit 0, reports PARSE_ERROR
pyric rules lint --service database: exit 0, 0 issues
```

On Air Hockey's generated `app/database.rules.json`, `pyric rules lint --service database` also reports 0 findings where `lint()` on the TypeScript definition reports 11 warnings.

## Suspected cause

Confirmed by reading. `CompiledRtdbRulesDocument.check()` in `packages/pyric/src/rules/api/rtdb.ts:188-194` returns `{ ok: true, errors: [], warnings: [] }` without looking at the compiled tree, so `rtdbRules(json).lint()` is always empty, and the CLI's `rules lint` for the database service calls exactly that (`packages/cli/src/bridge/surface/rules-engines/database.ts:100`). `runDatabaseRulesValidate` in `packages/cli/src/cli/database-rules.ts` prints the findings and returns 0 whatever they are (line 107).

## Suggested fix and failing test

Have `CompiledRtdbRulesDocument.check()` collect the parsed findings from the compiled tree the way `DefinedRtdbRulesDocument.check()` does (`collectFindings` in `constraints/document.ts`), and return a non-zero exit from `database rules validate` when there are errors. Failing tests first: `rtdbRules(json).lint()` on the repro's rule reports PARSE_ERROR (`test/rules/rtdb-export.test.ts`), and the CLI test for `database rules validate` expects exit 1 for a file with a parse error.

## Workaround in pyric-games

The Air Hockey rules test lints the TypeScript definition (`airHockeyRtdbRules.lint()`), not the JSON, and the drift check keeps the JSON equal to the definition's output.

## Fixed

Fixed by Pyric PR #782, merged as e88388ba, and verified on Pyric main dbc35150 (vendored as local-6). Checks on an RTDB rules JSON file now report their errors and fail on them. `bun bugs/repro/0015.ts` exits 0: `rtdbRules(json).lint()` reports PARSE_ERROR, and `pyric database rules validate` and `pyric rules lint --service database` exit 2.

Nothing to drop in the arcade: the Air Hockey unit test lints the TypeScript definition, and the drift check keeps `app/database.rules.json` equal to its output.
