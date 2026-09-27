---
id: 0016
title: Realtime Database lint reports any boolean literal as a hardcoded rule, and gives every issue origin 'validate'
severity: minor
package: pyric
pyric_commit: 9c125203
found_in: Air Hockey RTDB rules lint (meta's .write compares presence to false)
status: fixed
fixed_in: dbc35150 (#783, 2fe0d4c4)
---
## Summary

`lint()` on an RTDB ruleset reports `HARDCODED_FALSE` ("Rule expression is hardcoded to false") for a rule that only contains `false` as an operand, such as `data.child('open').val() == false`; the same goes for `true` and `HARDCODED_TRUE`. A rule that compares a flag to a literal is ordinary, so the warning is noise that hides the real ones (a rule that is `false` outright). Separately, every RTDB issue comes back with `origin: 'validate'`: a PARSE_ERROR is not marked `'parse'`, the hardcoded-rule warnings are not marked `'lint'`, and the finding's rule (`.read`, `.write` or `.validate`) is dropped, so two warnings at `/` for its `.read` and `.write` are indistinguishable.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0016.ts
```

## Expected

No warning for `auth != null && data.child('open').val() == false`. A `.read` or `.write` that is `false` outright is reported with origin `'lint'` (and says which rule), and a rule that doesn't parse with origin `'parse'`, as `RuleIssueOrigin` documents.

## Actual

```text
write rule comparing a value to false: HARDCODED_FALSE (origin validate)
read and write rules that are false: HARDCODED_FALSE (origin validate), HARDCODED_FALSE (origin validate)
write rule that does not parse: PARSE_ERROR (origin validate)
```

## Suspected cause

`packages/pyric/src/rules/rtdb/grammar/linter.ts:46-54`: the `bool_true` and `bool_false` actions push a warning for every boolean literal node anywhere in the expression; they should fire only when the whole expression is a literal. `rtdbFindingToIssue` in `packages/pyric/src/rules/api/issue.ts:90-101` sets `origin: 'validate'` for every finding and doesn't carry `finding.rule`.

## Suggested fix and failing test

Report HARDCODED_* only when the expression's top node is the literal; map PARSE_ERROR to `'parse'` and linter codes to `'lint'`, and keep the rule kind (in `path` or a field). Failing test first: the repro's three rulesets in `test/rules/rtdb/grammar/linter.test.ts` and the issue-mapping test.

## Workaround in pyric-games

The Air Hockey rules unit test asserts the exact list of warnings, with the two false positives on meta's `.write` noted there.

## Fixed

Fixed by Pyric PR #783, merged as 2fe0d4c4, and verified on Pyric main dbc35150 (vendored as local-6). RTDB lint now reports a hardcoded rule only when the whole expression is a literal, and each issue names its origin and rule. `bun bugs/repro/0016.ts` exits 0: a rule comparing a value to `false` has no issues, `false` read and write rules report HARDCODED_FALSE with origin lint, and a rule that does not parse reports PARSE_ERROR with origin parse.

Workaround dropped: the Air Hockey unit test no longer lists the two false positives on meta's `.write`. Its expected warnings are the root's `false` `.read` and `.write`.
