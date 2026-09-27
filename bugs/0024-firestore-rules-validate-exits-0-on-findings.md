---
id: 0024
title: pyric firestore rules validate exits 0 when the validator reports a high-severity finding, so CI can't gate on it
severity: minor
package: "@pyric/cli"
pyric_commit: 9c125203
found_in: reviewing the fix for 0015
status: open
---
## Summary

`pyric firestore rules validate <path>` prints the validator's findings as JSON and exits 0 whenever the rules parse, whatever the findings are. A call to an undefined function (SEM-4, severity high) and a missing default-deny match (SEC-4, severity medium) exit the same way as clean rules. Only a parse error exits 2. The Realtime Database command had the same shape (0015); its fix exits 2 on error findings.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0024.ts
```

The script writes a Firestore ruleset whose read rule calls `notDefined()` and runs `pyric firestore rules validate` on it.

## Expected

A nonzero exit code when a finding at or above a failing severity is reported, so a CI step or an agent can gate on it; 0 when none is.

## Actual

On local-5 (exit 1):

```text
firestore rules validate: exit 0, high-severity findings: SEM-4
```

## Suspected cause

Confirmed by running and reading. `packages/cli/src/cli/rules.ts:71-73`: after `validateFn(ast)` the command prints the findings and returns 0 unconditionally; only the parse failure at lines 68-69 returns 2.

## Suggested fix and failing test

Exit 2 when any finding has the failing severity, matching the Realtime Database command. Which severities fail is a decision: high only, or high and medium. The validator's severities are high, medium and low, while the RTDB command uses error and warning. Failing tests first in the command's test file: SEM-4 exits 2, a ruleset with only low findings exits 0, and a parse error still exits 2. Document the exit codes where the command is documented.

## Workaround in pyric-games

Gate on `bun run lint` (tools/lint-rules.ts), which fails on lint errors, instead of on this command's exit code.
