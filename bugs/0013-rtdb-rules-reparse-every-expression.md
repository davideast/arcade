---
id: 0013
title: The Realtime Database rules engine parses a rule's expression text on every evaluation, so a write's cost grows with the length of the rules it touches
severity: major
package: pyric
pyric_commit: 9c125203
found_in: Air Hockey (a host frame cost about 48 ms in the sandbox)
status: open
---
## Summary

Every time the RTDB rules engine evaluates a `.read`, `.write` or `.validate` rule it runs the grammar over the rule's text again. Parsing is about 85% of an evaluation, and it scales with the text, so a long rule costs far more than its work. Air Hockey's first ruleset made one host frame (a multi-path update of three nodes) cost about 48 ms in the sandbox; at 20 frames a second from the host plus the guest's mallet writes, that is most of a core in the Vite server for one match. It compounds with 0012 (every write evaluates its siblings' `.validate` rules) and with multi-path updates, which run the whole evaluation once per written path.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0013.ts
```

One `.write` rule, `auth != null` joined with `&&` once and 40 times (the same meaning, 40 times the text), 200 writes each, and 200 parses of the 40-term rule with `parseExpression`. The 40-term rule still runs 40 comparisons per write, so the check compares a write with one parse: it exits 1 while a 40-term write costs more than half a parse, which happens only when every evaluation parses again.

## Expected

Each rule is parsed once and a write evaluates the parsed tree, so a 40-term write costs its 40 comparisons, well under one parse of the rule.

## Actual

```text
1 term: 0.131 ms per write
40 terms: 1.973 ms per write (15.0x)
parsing the 40-term rule once: 1.932 ms
```

A 40-term write costs about one parse (exit 1). With each rule parsed once, the same run gives 0.221 ms per 40-term write against 1.945 ms per parse (exit 0); the remaining 4.6x over the 1-term rule is the 39 extra comparisons.

Timing `matchRtdbExpression` alone on the 40-term text: 1.80 ms per parse, against 2.12 ms per full evaluation.

## Suspected cause

Confirmed by reading and timing. `evaluateRtdbExpression` (`packages/pyric/src/rules/rtdb/grammar/simulator.ts:398-403`) calls `matchRtdbExpression(raw)` on every call, and the handler evaluates rules by their text (`handler.ts:132` for `.validate`, `handler.ts:545-546` for `.read`/`.write`). The compiled `RtdbRuleExpression` keeps the text and a validity flag but not the match. In the sandbox, `WritePlane.update` (`packages/pyric/src/database/sandbox/write-plane.ts:247-262`) also takes a full tree snapshot and runs the whole evaluation, including the `.validate` walk from the root, once per written path of a multi-path update.

## Suggested fix and failing test

Memoize the grammar match by expression text (a `Map<string, MatchResult>` in `evaluateRtdbExpression`), or keep it on the compiled expression. Failing test first: a sandbox performance test like the repro that asserts a long rule with trivial work costs within a small factor of a short one.

## Workaround in pyric-games

Air Hockey writes the host's frame as one node (one path, not three) and keeps long checks in `.write` rules only (see 0012), which brought a frame to about 6 ms. The host writes at 20 frames a second.
