---
id: 0027
title: The rules grammar has no bytes literal, so b'...' in a Firestore or Storage ruleset fails to parse
severity: minor
package: pyric
pyric_commit: 9c125203
found_in: fixing 0020 (a Storage rules scenario that needed a bytes value)
status: open
---
## Summary

The Firebase rules language has a bytes literal, `b'...'`, with the same escapes as a string. Pyric's rules grammar has none, so a ruleset that uses one fails to parse, with a message that points at the version line rather than the literal. The same bytes built with `'abc'.toUtf8()` parse and evaluate.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0027.ts
```

The script lints a Firestore ruleset whose read rule compares `b'abc'` with `'abc'.toUtf8()`, one that reads `b'\x00\x01'.size()`, and a control that uses only `toUtf8()`.

## Expected

All three parse.

## Actual

On local-5 (exit 1):

```text
b'abc' == 'abc'.toUtf8(): PARSE_ERROR
b'\x00\x01'.size() == 2: PARSE_ERROR
'abc'.toUtf8() == 'abc'.toUtf8(): parses
```

## Suspected cause

The shared rules grammar (the Ohm grammar under `packages/pyric/src/rules/grammar/`) defines string, int, float, bool, null and path literals but no bytes literal, so the tokenizer can't read `b'`.

## Suggested fix and failing test

Add a bytes literal to the grammar with the string escapes, evaluate it to the Bytes value the evaluators already produce for `toUtf8()`, for Firestore and Storage. Capture production's acceptance and equality (`b'abc' == 'abc'.toUtf8()`, escapes, `.size()`) through the Rules Test API as a corpus scenario first, since Pyric's conformance data doesn't record the literal. Failing tests first: this repro's cases in the grammar tests and in each evaluator.

## Workaround in pyric-games

Build bytes with `'...'.toUtf8()`. No arcade game uses a bytes literal.
