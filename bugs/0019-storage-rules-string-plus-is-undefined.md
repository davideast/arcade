---
id: 0019
title: In Storage rules, `+` on two strings evaluates to undefined; a built path never equals anything, so `==` denies and `!=` allows every request
severity: major
package: pyric
pyric_commit: 9c125203
found_in: Sokoban (the upload rule compared the score's object with 'sokoban/' + uid + '/' + level + '/' + file)
status: fixed
fixed_in: dbc35150 (#764, 8d7163d4)
---
## Summary

The Storage rules evaluator sends every `+` to its numeric helper, which returns `undefined` when an operand is not a number. So `'a' + 'b'` is not `'ab'` and is not an error either: it is a value equal to nothing. A rule that builds a path or a file name with `+` and compares it with `==` denies every request (a false DENY), and one that compares it with `!=` allows every request (a false ALLOW). Lists concatenated with `+` behave the same way.

Pyric's Firestore evaluator concatenates two strings and two lists, and records string + string and list + list as the CEL `+` overloads (`packages/pyric/src/rules/simulator/evaluator.ts:478-494`); production Firestore accepts `'c' + string(n)` (capture `map-index-computed-keys`, cited in bug 0006). Pyric has no production capture of `+` on strings in Storage rules, and `packages/conformance/rules-language/storage.json` has no construct for it. Whatever production does with it, it either concatenates or fails the expression (a deny that `!=` can't turn into an allow); a non-error value that equals nothing matches neither.

## Reproduction

From the repository root:

```bash
bun bugs/repro/0019.ts
```

Alice uploads `users/alice/a.txt` under `match /users/{uid}/{file}` with one `allow create` condition per case.

## Expected

```text
'a' + 'b' == 'ab': ALLOW
'users/' + uid + '/' + file == 'users/alice/a.txt': ALLOW
'a' + 'b' != 'ab': DENY
'users/' + request.auth.uid != 'users/alice': DENY
[1] + [2] == [1, 2]: DENY
1 + 2 == 3: ALLOW
```

A production capture through the Rules Test API, taken while fixing this bug, shows Storage rules have no `list + list`: it fails with "Unsupported operation error. Received: list + list.", as does `+` on a string and a number, and the error denies. The list case expects DENY for that reason.

## Actual

```text
'a' + 'b' == 'ab': DENY (expected ALLOW)
'users/' + uid + '/' + file == 'users/alice/a.txt': DENY (expected ALLOW)
'a' + 'b' != 'ab': ALLOW (expected DENY)
'users/' + request.auth.uid != 'users/alice': ALLOW (expected DENY)
[1] + [2] == [1, 2]: DENY (expected DENY)
1 + 2 == 3: ALLOW (expected ALLOW)
```

The deny reason is `condition false`, which doesn't point at the `+`.

## Suspected cause

Confirmed by reading. `packages/pyric/src/storage/sandbox/rules-evaluator.ts:391`: `case '+': return numOp(l, r, (a, b) => a + b);`. `numOp` (`packages/pyric/src/storage/sandbox/rules-operators.ts:87-93`) returns `undefined` when `numVal` of either operand is `undefined`, which it is for a string or a list. `==` then compares `undefined` with a string through `rulesEquals` and returns false, and `!=` returns true.

## Suggested fix and failing test

In the Storage evaluator's `+`, concatenate two strings, keep numeric addition, and return a `RuleError` (absorbable, so it denies) for any other pair, including two lists: production's Storage `+` overloads are int, float, string, and the duration and timestamp pairs. More generally, `numOp` and the other operator helpers should return a `RuleError` rather than `undefined` for operand types they don't support, so no operator can produce a value that silently compares unequal. Failing test first: the repro's six cases in `packages/pyric/test/storage/sandbox/rules-evaluator.test.ts`, and a Storage corpus scenario with `+` on strings and lists captured against the Rules Test API so the language inventory gains a row with evidence.

## Workaround in pyric-games

`app/storage.rules` splits strings instead of building them: the upload rule compares `score.object.split('/')[3] == file` and reads the counts from `file.split('[-.]')`, with the Firestore rules (which concatenate correctly) fixing the object's full path.

## Fixed

Fixed by Pyric PR #764, merged as 8d7163d4, and verified on Pyric main dbc35150 (vendored as local-6). Storage `+` now concatenates two strings, adds numbers, and errors (so denies) on any other pair. `bun bugs/repro/0019.ts` exits 0: every case matches its expected verdict.

Workaround dropped: with 0020 and 0021, `app/storage.rules` no longer splits strings. Sokoban's upload rule compares `request.resource.name == score.object`.
