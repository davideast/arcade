---
id: 0007
title: The sandbox re-parses the whole ruleset on every rules-evaluated request, so a 24 KB ruleset costs about 55 ms per write
severity: major
package: pyric
pyric_commit: 92d52b02
found_in: uno rules test (3 and 4 player games timed out)
status: fixed
fixed_in: 87a5303e (#769, e215e92f)
---
## Summary

Every write and read the sandbox checks against rules calls `simulator.simulate(rules.source, ...)`, which parses the ruleset source again. With the arcade's resolved ruleset (24 KB, six games' worth of functions), one denied write costs about 54 ms, against 0.5 ms with a one-rule ruleset; parsing that ruleset once costs about 58 ms. The cost is paid in the browser sandbox too, on every Firestore operation the page makes, and grows with every game added. An Uno game with four players and cheat attempts took minutes in Node.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0007.ts
```

## Expected

The ruleset is parsed once when it is set (or changes), and each request evaluates the parsed tree; per-request cost does not scale with ruleset size.

## Actual

```text
one-rule ruleset: 0.5 ms per write
arcade ruleset (24080 bytes): 54.2 ms per write
parsing the arcade ruleset once: 57.7 ms
```

(Figures from 2026-09-26 on an Apple Silicon Mac; the script's exit code compares the two write costs.)

In the browser under `vite dev`, the host's Start for a four-player Uno table (one batch: the match update, 108 deck documents, 28 draws documents and one played document, each checked against the rules with `get`/`getAfter` lookups) took about 20 seconds before the table appeared on every tab.

## Suspected cause

Confirmed by reading. `packages/pyric/src/firestore/sandbox/rules-simulator.ts:26` calls `simulator.simulate(rules.source, testCases, ...)`, and `SimulateFirestoreRulesHandler.simulate` in `packages/pyric/src/rules/simulator/handler.ts` (about line 461) runs `parseToAST(source)` on each call. `packages/pyric/src/firestore/sandbox/rules-state.ts:77` already holds a parsed `ast` for the current source that the request path doesn't use. The read engine (`rules-read-engine.ts:137`) and list authorizer (`rules-list-authorizer.ts:149`) follow the same pattern.

## Suggested fix and failing test

Let `simulate` accept a parsed ruleset (or memoize `parseToAST` by source string), and pass the `ast` from `RulesState` on the request path. Failing test first: a sandbox performance test that sets a large generated ruleset (hundreds of functions) and asserts per-write time is within a small factor of a one-rule ruleset; `bugs/repro/0007.ts` is the shape.

## Workaround in pyric-games

The Uno rules test runs one game each for three and four players, with a longer timeout.

## Fixed

Fixed by Pyric PR #769, merged as e215e92f, and verified on Pyric main 87a5303e (vendored as local-4). `bun bugs/repro/0007.ts` exits 0: a write under the arcade ruleset (63,527 bytes) costs 3.5 ms, down from about 152 ms, against about 161 ms to parse the ruleset once. The repro used to compare against a one-rule ruleset, which still fails because the arcade's rules do more work per write; it now checks that a write costs well under one parse. Per-write cost no longer grows with ruleset size: padding a one-rule ruleset with 800 unused functions (72 KB) leaves a write at 0.07 ms. In the browser, under hosted mode, a four-player Uno deal now takes about 0.7 s until every player has their seven draw records and about 1.0 s until all seven card faces show, down from about 20 s.

Dropped in 3e39e4c: Uno plays three games at every player count, the per-game short probe modes are gone, and all six rules tests run in about 15 seconds.
