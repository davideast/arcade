---
id: 0031
title: The rules assembler prints a double-quoted string that contains an apostrophe as an unparseable single-quoted string
severity: minor
package: pyric
pyric_commit: ac639e30
found_in: fixing 0030 (checking printers for escape assumptions)
status: open
---
## Summary

The Firestore rules assembler turns a double-quoted string literal into a single-quoted one by swapping the outer quotes of its source text, without escaping an inner `'`. `"it's"` prints as `'it's'`, which does not parse. The module resolver's output goes through this printer, so resolving a `rules_version = '2+modules'` ruleset that compares with `"it's"` returns source that neither Pyric nor production can parse. Simulator trace text and query-proof predicates use the same printer.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0031.ts
```

The script parses a ruleset whose read condition is `resource.data.s == "it's"`, prints it with `assembleRules`, and parses the printed ruleset again.

## Expected

The printed ruleset parses to the same value, for example with `'it\'s'`, or with the double-quoted source text kept.

## Actual

On local-5, and unchanged on Pyric main ac639e30 (exit 1):

```text
printed: allow read: if resource.data.s == 'it's';
printed ruleset does not parse
```

## Suspected cause

The `case 'literal'` branch of `assembleExprInner` in `packages/pyric/src/rules/grammar/FirestoreAssembler.ts` returns `'${inner}'` from a double-quoted `raw` with no escaping of `'`.

## Suggested fix and failing test

Print the literal so it parses to the same value: keep a double-quoted `raw` as is, or escape each unescaped `'` (and unescape `\"`) when switching quotes. Failing tests first: a round-trip test that parses, prints and reparses string literals with apostrophes, double quotes and escapes, and this repro's case through `resolveModulesWithFiles`. This is printer behavior with no production counterpart; the check is that the printed text parses to the same value.

## Workaround in pyric-games

None needed. No arcade ruleset has an apostrophe in a double-quoted string.
