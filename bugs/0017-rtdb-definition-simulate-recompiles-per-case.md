---
id: 0017
title: simulate on a handle made from a TypeScript RTDB definition compiles the whole definition for every case, about 100 times slower than the same rules as JSON
severity: minor
package: pyric
pyric_commit: 9c125203
found_in: Air Hockey rules test (about 72 ms per simulated case)
status: open
---
## Summary

`rtdbRules(defineRtdbRules({ paths }))` gives a handle whose `simulate(cases)` builds the ruleset from the definition again for each case: every path, every expression parsed and validated. With Air Hockey's definition a case cost about 72 ms, so cross-checking a sandbox run's two thousand writes through the definition handle would take minutes. The same rules through `rtdbRules(handle.toJSON())` cost about half a millisecond per case.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0017.ts
```

Forty paths, each with a ten-term `.write`, 40 cases through each handle.

## Expected

The definition compiles once (or once per `simulate` call), and a case costs about what it costs through the JSON handle.

## Actual

```text
definition handle: 181.15 ms per case
JSON handle: 1.46 ms per case
```

## Suspected cause

Confirmed by reading. `DefinedRtdbRulesDocument.simulate` (`packages/pyric/src/rules/rtdb/constraints/document.ts:152-154`) calls `this.compile()`, which runs `ruleset(this.definition.paths)` (line 120-122), and `DocumentRtdbRuleset.simulate` in `packages/pyric/src/rules/api/rtdb.ts` calls the document's `simulate` once per case. `CompiledRtdbRulesDocument` compiles once in its constructor.

## Suggested fix and failing test

Compile the definition once, lazily, and reuse it (the definition is immutable once passed in). Failing test first: the repro's comparison, or a spy on `ruleset` asserting one compile for a multi-case `simulate`.

## Workaround in pyric-games

The Air Hockey sandbox test cross-checks through `rtdbRules(json)` on the generated file; the unit test runs its 28 cases through the definition handle.
