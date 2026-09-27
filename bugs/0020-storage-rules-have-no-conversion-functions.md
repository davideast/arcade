---
id: 0020
title: Storage rules have no global `int()`, `string()` or `float()`; any rule that converts a value denies with "undefined function int()"
severity: major
package: pyric
pyric_commit: 9c125203
found_in: Sokoban (the upload rule compares the object's custom metadata, which is always strings, with the score document's int counts)
status: fixed
fixed_in: dbc35150 (#789, e9c42663)
---
## Summary

The Storage rules evaluator resolves a bare call such as `int(x)` only against the ruleset's own functions. `int`, `string` and `float` are not there, so the call throws `undefined function int()` and the rule denies. Every rule that converts a value denies, whatever the value.

The Firebase rules language reference (https://firebase.google.com/docs/reference/rules/rules) lists `int()`, `string()` and `float()` as global functions of the rules language, not of one service. Pyric's Firestore evaluator implements all three, and Pyric records them as `firestore.function.cast.int`, `.string` and `.float` in `packages/conformance/rules-language/firestore.json` with production captures behind them (`rules-firestore-time-math-and-casts`). Pyric has no production capture of them in Storage rules: `packages/conformance/rules-language/storage.json` has no construct for them, and neither `packages/conformance/registry/rules.ts` nor `packages/conformance/registry/storage.ts` has a row for them. Their support in Storage rules is documented but not captured by Pyric.

Custom metadata values are strings in Storage, so a rule that compares one with a number (from `firestore.get()`, or `request.resource.size`) needs `int()`.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0020.ts
```

Alice uploads `users/alice/a.txt` (2 bytes, `text/plain`, custom metadata `moves: '12'`) under `match /users/{uid}/{file}` with one `allow create` condition per case. The last case is a control without a conversion.

## Expected

Per the rules language reference:

```text
int('12') == 12: ALLOW
int(request.resource.metadata.moves) == 12: ALLOW
int(2.0) == 2: ALLOW
string(12) == '12': ALLOW
float('2.0') == 2.0: ALLOW
float(2) == 2.0: ALLOW
request.resource.metadata.moves == '12': ALLOW
```

## Actual

Exit code 1:

```text
int('12') == 12: DENY (expected ALLOW)
int(request.resource.metadata.moves) == 12: DENY (expected ALLOW)
int(2.0) == 2: DENY (expected ALLOW)
string(12) == '12': DENY (expected ALLOW)
float('2.0') == 2.0: DENY (expected ALLOW)
float(2) == 2.0: DENY (expected ALLOW)
request.resource.metadata.moves == '12': ALLOW (expected ALLOW)
```

The deny reason ends in `match /users/{uid}/{file} create: undefined function int().`

## Suspected cause

Confirmed by reading. `evalCall` in `packages/pyric/src/storage/sandbox/rules-evaluator.ts:480-487` looks the name up in `ctx.funcs`, the ruleset's user-defined functions, and throws `RuleUnsupportedError('undefined function ${expr.name}()')` when it is absent. No global function table is consulted first. `RuleUnsupportedError` is not absorbable by `&&` or `||` (`rules-evaluator.ts:449-452`), so `int('12') == 12 || true` also denies. The Firestore evaluator handles the same names in `packages/pyric/src/rules/simulator/evaluation-builtins.ts:143-145`.

## Suggested fix and failing test

Capture first: add a Storage corpus scenario under `packages/conformance/rules-corpus/storage/` with `int()`, `string()` and `float()` on strings, ints, floats and invalid input (for example `int('x')`), run it against the Rules Test API, and add `storage.function.cast.int`, `.string` and `.float` to `packages/conformance/rules-language/storage.json` with a registry row in `packages/conformance/registry/rules.ts` citing the observation. Then, in `evalCall`, resolve `int`, `string` and `float` as globals when the ruleset defines no function of that name, with the conversion rules the capture shows (the Firestore helpers `rulesInt` and `rulesFloatBuiltin` are the likely starting point), and return an absorbable `RuleError` for input the conversion rejects. Failing test: the repro's cases in `packages/pyric/test/storage/sandbox/rules-evaluator.test.ts`, plus the captured scenario replayed by the oracle conformance test.

## Workaround in pyric-games

`app/storage.rules` never converts a value. Sokoban's upload rule compares strings with strings and ints with ints:

- The custom metadata counts (strings) are compared with pieces of the file name, `parts[1] == meta.moves` and `parts[2] == meta.pushes`, where `parts = file.split('[-.]')`.
- The file name is tied to the score's int counts through `score.object.split('/')[3] == file`. The Firestore rules (`games/sokoban/sokoban.rules`), where `string()` works, fix `object` to `'sokoban/' + uid + '/' + level + '/' + d.solve + '-' + string(d.moves) + '-' + string(d.pushes) + '.txt'`.
- The object's size, an int, is compared with the score's int directly: `request.resource.size == score.moves`.

## Fixed

Fixed by Pyric PR #789, merged as e9c42663, and verified on Pyric main dbc35150 (vendored as local-6). Storage rules now have the global `int()`, `string()` and `float()`. `bun bugs/repro/0020.ts` exits 0: all seven conversions match their expected verdicts.

Workaround dropped: Sokoban's upload rule compares the metadata counts with the score's through `string()`: `meta.moves == string(score.moves)` and `meta.pushes == string(score.pushes)`. The file name is no longer split.
