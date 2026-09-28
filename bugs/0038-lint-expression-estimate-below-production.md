---
id: 0038
title: The EXPRESSION_BUDGET estimate is below production's count for ternaries that take their false branch, so a rule production stops at the limit lints silent
severity: major
package: pyric
pyric_commit: 380f84ac
found_in: checking the restructured Reversi move rule's lint estimate against production's measured cost
status: open
---
## Summary

Lint's EXPRESSION_BUDGET estimate is meant to be an upper bound on what production's 1,000-expression limit counts for a request a rule grants. It is not for ternaries. Production charges a ternary 2 plus its condition and branch when the condition is true, and 4 when it is false; the estimator on Pyric main charges 2 for either branch. The restructured Reversi move rule lints at 784 on Pyric main (8b3c2c84 in the Reversi measurement table, and 380f84ac), while production measured 797 to 802 for its most expensive recorded write (random seed 8, write 54). A rule built from false-branch ternaries can pass the limit in production with no EXPRESSION_BUDGET warning.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0038.ts
```

The script lints one rule of 90 conjuncts `(resource.data.a == 1 ? true : true)`. With `a == 0` every ternary takes its false branch, and production (Rules Test API, digame-mas) denies the request at the limit; with `a == 1` production allows it, and Pyric's simulator counts 898.

## Expected

An EXPRESSION_BUDGET warning with an estimate of at least 1,000: the rule costs 90 × (4 + 5 + 1) plus 2 for each of the 89 `&&`, 1,078, when its ternaries take the false branch.

## Actual

On local-6 (exit 1):

```text
90 false-branch ternaries: lint estimate ~809; production DENY at the 1000-expression limit when every ternary takes its false branch
```

On Pyric main 380f84ac the estimate is 898 and no warning is reported (the rule warns only at 1,000 or more).

## Suspected cause

`packages/pyric/src/rules/linter/expression-cost.ts`, `case 'ternary'`: `2 + max(condition + consequent, condition + alternate)`. The false branch needs 4. On the Reversi write, comparing each evaluated node's cost with the estimate finds four under-counted leaves, all false-branch ternaries: `flips ? n : 0`, `(flips ? flipped : theirs).hasAll(...)` and the outer `... ? ... : -100` in `reversiRun`, and `resource.data.currentTurn == 'host' ? 'd' : 'l'` when the guest moves. `hasAny` and `hasAll` over computed sets, string indexing into the rays table, and `let` bindings are costed at or above production.

## Suggested fix and failing test

Charge 2 on the true branch and 4 on the false branch and take the more expensive when the condition is unknown; a boolean literal branch that cannot yield the wanted value is not costed. Failing tests first: the estimator's ternary cost for each branch, the Reversi write in the estimator's production fixture with its 797 to 802 window, and this repro's rule. Pyric PR 820 makes this change: the Reversi move rule then lints at 826 and this rule at 1,078.

## Workaround in pyric-games

None needed for Reversi: the rule measures under 805 in production, about 195 below the limit. Until the fix lands, read EXPRESSION_BUDGET estimates for rules with many false-branch ternaries as low by about 2 per ternary.
