---
id: 0030
title: Rules string literals reject the \x, \u, octal, \b and \f escapes production accepts, and accept the \/ escape production rejects
severity: minor
package: pyric
pyric_commit: fa5c99be
found_in: fixing 0027 (bytes literal probes through the Rules Test API)
status: open
---
## Summary

Pyric's rules grammar allows only `\\ \' \" \n \r \t \/` after a backslash in a string literal. Production accepts `'\x41' == 'A'`, `'\u0041' == 'A'`, `'\101' == 'A'`, `'\377'`, `\b` and `\f`, and rejects `'\/'` with "Missing 'match' keyword before path". A valid ruleset that uses one of those escapes fails to parse in Pyric, and a ruleset that production refuses to deploy parses.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0030.ts
```

The script lints Firestore rulesets whose read condition compares `'\x41'`, `'\u0041'` and `'\101'` with `'A'`, and one that uses `'\/'`.

## Expected

The three accepted escapes parse; `'\/'` is a parse error, as in production.

## Actual

On local-5, and unchanged on Pyric main fa5c99be (exit 1):

```text
'\x41' == 'A': PARSE_ERROR (production accepts it)
'\u0041' == 'A': PARSE_ERROR (production accepts it)
'\101' == 'A': PARSE_ERROR (production accepts it)
'\/' == '/': parses (production rejects it)
```

## Suspected cause

`stringEscapeChar` in `packages/pyric/src/rules/grammar/FirestoreRules.ohm` and `processStringEscapes` in `FirestoreParser.ts`. `test/rules/grammar/string-escape-strict.test.ts` pins the current set. The bytes literal added for 0027 already has the production escape rule (`bytesEscape`) apart from `\u`.

## Suggested fix and failing test

Capture string escapes through the Rules Test API as a corpus scenario: `\x`, `\u`, octal, `\b`, `\f`, and the rejection of `\/`, `\a`, `\v`, `\0`, `\x4` and `\U`. Share one escape rule between strings and bytes, with `\u` for strings only, and update `string-escape-strict.test.ts` to the captured set. Failing tests first: this repro's cases in the grammar tests and in the Firestore and Storage evaluators.

## Workaround in pyric-games

None needed. No arcade ruleset uses these escapes.
