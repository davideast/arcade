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

One `.write` rule, `auth != null` joined with `&&` once and 40 times (the same meaning, 40 times the text), 200 writes each.

## Expected

Each rule is parsed once, when the rules are set, and a write evaluates the parsed tree; the 40-term rule costs little more than the 1-term rule.

## Actual

```text
1 term: 0.133 ms per write
40 terms: 2.239 ms per write (16.8x)
```

Timing `matchRtdbExpression` alone on the 40-term text: 1.80 ms per parse, against 2.12 ms per full evaluation.

## Suspected cause

Confirmed by reading and timing. `evaluateRtdbExpression` (`packages/pyric/src/rules/rtdb/grammar/simulator.ts:398-403`) calls `matchRtdbExpression(raw)` on every call, and the handler evaluates rules by their text (`handler.ts:132` for `.validate`, `handler.ts:545-546` for `.read`/`.write`). The compiled `RtdbRuleExpression` keeps the text and a validity flag but not the match. In the sandbox, `WritePlane.update` (`packages/pyric/src/database/sandbox/write-plane.ts:247-262`) also takes a full tree snapshot and runs the whole evaluation, including the `.validate` walk from the root, once per written path of a multi-path update.

## Suggested fix and failing test

Memoize the grammar match by expression text (a `Map<string, MatchResult>` in `evaluateRtdbExpression`), or keep it on the compiled expression. Failing test first: a sandbox performance test like the repro that asserts a long rule with trivial work costs within a small factor of a short one.

## Workaround in pyric-games

Air Hockey writes the host's frame as one node (one path, not three) and keeps long checks in `.write` rules only (see 0012), which brought a frame to about 6 ms. The host writes at 20 frames a second.
