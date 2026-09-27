---
id: 0014
title: Realtime Database rules can't use === or !==; the rule `$uid === auth.uid` doesn't parse, so the sandbox denies the owner
severity: major
package: pyric
pyric_commit: 9c125203
found_in: Air Hockey (checking which RTDB operators the rules grammar accepts before writing the rules)
status: fixed
fixed_in: dbc35150 (#781, c12c11f0)
---
## Summary

The RTDB rules grammar has `==` and `!=` but not `===` and `!==`. Production RTDB rules accept both forms, and Firebase's own RTDB security rules guides write per-user rules as `"$uid === auth.uid"`. In Pyric such a rule doesn't parse: the sandbox treats it as unsupported and denies every request it governs, `simulate` answers UNSUPPORTED, and `pyric database rules validate` reports PARSE_ERROR. An app that pastes a standard ruleset into `database.rules.json` gets every owner read and write denied.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0014.ts
```

The owner `alice` writes `/users/alice` under `.write` rules `$uid == auth.uid`, `$uid === auth.uid` and `$uid !== "nobody" && $uid == auth.uid`.

## Expected

All three are allowed, in the sandbox and in `simulate`.

## Actual

```text
$uid == auth.uid: sandbox ALLOW, simulate ALLOW
$uid === auth.uid: sandbox DENY, simulate UNSUPPORTED ('write' rule at '/users/$uid' contains an expression the simulator cannot evaluate: $uid =)
$uid !== "nobody": sandbox DENY, simulate UNSUPPORTED ('write' rule at '/users/$uid' contains an expression the simulator cannot evaluate: $uid !)
```

`pyric database rules validate` on the same rules prints `PARSE_ERROR` at `Line 1, col 8: $uid === auth.uid`.

## Suspected cause

`packages/pyric/src/rules/rtdb/grammar/RtdbExpr.ohm:14-21`: `Comparison` has `==` (`looseEq`) and `!=` (`looseNeq`) and no `===` or `!==` alternatives, so the parser stops at the third `=`. The conformance registry says the operators are covered: `packages/conformance/registry/rules.ts:1019` describes "`$uid` path-variable ownership (`$uid === auth.uid`)" and line 1072 lists "`!==`" among the operators r9 proves, but the corpus scenarios those rows cite (`rules-corpus/rtdb/r2-own-uid.ts`, `r9-quota-arithmetic.ts`) use `==` and `!=`.

## Suggested fix and failing test

Add `Comparison "===" Additive -- strictEq` and `Comparison "!==" Additive -- strictNeq` before the two-character forms, evaluate them like `==`/`!=` (RTDB's `==` is already strict in production), and handle them in the linter and identifier semantics. Failing test first: the repro's three rules in `test/rules/rtdb/grammar/simulator.test.ts`, and a corpus scenario that uses `===` and `!==` captured against production so the registry rows cite real evidence.

## Workaround in pyric-games

Air Hockey's rules are written with the constraint builders, which emit `==` and `!=`.

## Fixed

Fixed by Pyric PR #781, merged as c12c11f0, and verified on Pyric main dbc35150 (vendored as local-6). RTDB rule expressions now parse and evaluate `===` and `!==`. `bun bugs/repro/0014.ts` exits 0: all three rules allow the owner in the sandbox and in `simulate`.

Nothing to drop in the arcade: the constraint builders emit `==` and `!=`, which compare without converting types, as production does (0022).
