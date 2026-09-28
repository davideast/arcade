---
id: 0032
title: The Firestore rules simulator allows a request that production denies for passing the 1,000-expression budget
severity: major
package: pyric
pyric_commit: dbc35150
found_in: verifying the chess showcase rules against the Rules Test API
status: fixed
fixed_in: eb748488 (#814, 7342c713)
---
## Summary

Production evaluates at most 1,000 expressions per request and denies the request when the budget runs out, with the message "Unable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached". `firestoreRules(...).simulate` has no budget: a request that production denies for cost is reported ALLOW, and the trace records one node for the whole rule. A ruleset can pass every simulated case and deny in production. The chess showcase did: the Fool's Mate position after f3 e5 g4, then d8 to h4 with `moveType` `normal`, was ALLOW in the simulator and denied by production at the budget, on the rules before today's showcase fix.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0032.ts
```

The script builds a ruleset of twelve functions with 90 comparisons each, all true, called from one `allow create`, and simulates a create that reaches all of them.

## Expected

The simulator denies the request and names the budget, as production does, and the trace shows how many expressions were evaluated so the author can see the margin.

## Actual

On local-6 (exit 1):

```text
about 1,080 comparisons in one request: simulate ALLOW (1 trace nodes); production DENY at 1000 expressions
```

## Suspected cause

The evaluator in `packages/pyric/src/rules/simulator` counts nothing per evaluated node; the trace recorder records rule-level entries, not expressions. The lint EXPRESSION_BUDGET warning is a static estimate (about 3x production on the chess rules) and is not consulted at simulation time.

## Suggested fix and failing test

Count evaluated expressions in the evaluator with the same unit production uses (the calibration against Rules Test API `ExpressionReport` records establishes it) and return a DENY with a budget reason when the count passes 1,000. Expose the count in the case result so tests can assert a margin. Failing tests first: this repro's case in the simulator tests, and the chess Fool's Mate case against the pre-fix showcase rules as a production-backed scenario.

## Workaround in pyric-games

Run the game's worst-case writes through the Rules Test API before relying on a simulator pass. Reversi's recorded worst case (1,034 simulator nodes) is the first candidate.

## Fixed

Fixed by Pyric PR #814, merged as 7342c713, and verified on Pyric main eb748488 (vendored as local-7). The Firestore simulator counts evaluated expressions and denies a request at production's limit of 1,000 with production's message. `bun bugs/repro/0032.ts` exits 0: about 1,080 comparisons in one request are DENY in the simulator, as in production.

Nothing to drop in the arcade. The Reversi move rule was restructured to fit the budget before this fix landed; the local-7 rules test runs every game under the limit.
