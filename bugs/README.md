# Pyric bugs found building Pyric Arcade

Each file holds one bug with its reproduction, the suspected Pyric source location, a suggested fix with its failing test, and the workaround used here. Scripts in `repro/` run from the repository root and exit 1 while the bug is present.

All eight are fixed on Pyric main 87a5303e, vendored here as local-4. Every repro exits 0 there except 0005, whose script checks the root export; that bug was in the guide, which now imports from `pyric-admin/firestore`.

0009 was found on local-4 and is fixed on Pyric main 9c125203, vendored here as local-5; its repro exits 0 there.

0010 and 0011 were found on local-5 (Pyric main 9c125203).

0012 to 0018 were found on local-5 building Air Hockey, the first game on the Realtime Database.

0019 to 0021 were found on local-5 building Sokoban, the first game on Cloud Storage.

0022 to 0028 were found while fixing 0014, 0015, 0018, 0020 and 0021, 0029 while playing Air Hockey, and 0030 and 0031 while fixing 0027 and 0030. The repros for 0010 to 0029 exit 1 on local-5.

0010 to 0031 are fixed on Pyric main dbc35150, vendored here as local-6; every repro exits 0 there except 0005 (see above).

0032 and 0033 were found on local-6 while verifying the chess showcase rules against the Rules Test API; both are open and their repros exit 1 on local-6.

0035 to 0037 were found on local-6 while fitting the Reversi move rule to production's expression budget; all three are open and their repros exit 1 on local-6.

| ID | Title | Severity | Package | Status |
|---|---|---|---|---|
| [0001](0001-let-bound-member-method-rejected-by-resolver.md) | In a module, a method on a field of a get()/getAfter() document (or a let or parameter bound to one) is rejected | blocker | pyric | fixed (#768) |
| [0002](0002-lint-ignores-service-scope-functions.md) | Rules lint reports zero functions for resolved modular rules | major | pyric | fixed (#772) |
| [0003](0003-vite-plugin-cannot-prebundle-hash-deps-under-bun.md) | Under Bun workspaces, `pyric()` cannot pre-bundle js-md5 and js-sha256; the page fails to load | blocker | @pyric/cli | fixed (#770) |
| [0004](0004-dotted-update-path-denied-by-rules.md) | A dotted-path update is denied where the equivalent whole-map update is allowed | major | pyric | fixed (#773) |
| [0005](0005-test-in-node-guide-imports-missing-export.md) | Docs: the "Test in Node" guide imports `getFirestore` from the `pyric-admin` root instead of `pyric-admin/firestore` | minor | site-docs | fixed (#774) |
| [0006](0006-module-functions-cannot-call-string-or-int.md) | Module resolution rejects Firestore's global `string()` and `int()` inside a module function | major | pyric | fixed (#771) |
| [0007](0007-sandbox-reparses-ruleset-on-every-request.md) | The sandbox re-parses the whole ruleset on every request; about 55 ms per write with a 24 KB ruleset | major | pyric | fixed (#769) |
| [0008](0008-failed-reload-never-watches-new-modules.md) | After a rules reload fails, modules the new source imports are never watched; fixing them doesn't reload | major | @pyric/cli | fixed (#775) |
| [0009](0009-hosted-event-replays-exceed-socket-backlog.md) | In hosted mode, four event-history replays exceed the 24 MiB socket backlog; every page reconnects about once a second | major | @pyric/cli | fixed (#777) |
| [0010](0010-lint-ignores-let-bindings-for-sec-3-and-sec-6.md) | Lint SEC-6 and SEC-3 ignore a called function's let bindings, so data or auth read through a let is reported as unchecked | minor | pyric | fixed (#780) |
| [0011](0011-studio-auth-direct-load-exceeds-operation-budget.md) | In hosted Studio, a direct load of the Auth page sends one request per history event and shows "This client already has 256 pending operations." | major | @pyric/studio | fixed (#785) |
| [0012](0012-rtdb-write-evaluates-unchanged-sibling-validate.md) | A Realtime Database write evaluates the `.validate` rules of unchanged sibling nodes, so a rule that requires a change denies unrelated writes | major | pyric | fixed (#784) |
| [0013](0013-rtdb-rules-reparse-every-expression.md) | The RTDB rules engine parses a rule's text on every evaluation; a write's cost grows with the length of the rules it touches | major | pyric | fixed (#784) |
| [0014](0014-rtdb-rules-reject-strict-equality.md) | RTDB rules can't use `===` or `!==`; `$uid === auth.uid` doesn't parse and the sandbox denies the owner | major | pyric | fixed (#781) |
| [0015](0015-rtdb-json-rules-checks-cannot-fail.md) | Checks on an RTDB rules JSON file can't fail: lint reports nothing for a rule that doesn't parse, and `database rules validate` exits 0 with errors | major | pyric, @pyric/cli | fixed (#782) |
| [0016](0016-rtdb-lint-hardcoded-false-positive-and-origin.md) | RTDB lint reports any boolean literal as a hardcoded rule, and gives every issue origin 'validate' | minor | pyric | fixed (#783) |
| [0017](0017-rtdb-definition-simulate-recompiles-per-case.md) | `simulate` on a TypeScript RTDB definition compiles the definition for every case, about 100 times slower than JSON | minor | pyric | fixed (#788) |
| [0018](0018-rtdb-simulate-unsupported-for-denied-request.md) | RTDB `simulate` reports UNSUPPORTED instead of DENY when the deepest rules node on the path has no rule of the request's kind | minor | pyric | fixed (#791) |
| [0019](0019-storage-rules-string-plus-is-undefined.md) | In Storage rules, `+` on two strings (or two lists) evaluates to undefined, so a built path compared with `==` denies and with `!=` allows every request | major | pyric | fixed (#764) |
| [0020](0020-storage-rules-have-no-conversion-functions.md) | Storage rules have no global `int()`, `string()` or `float()`; any rule that converts a value denies with "undefined function int()" | major | pyric | fixed (#789) |
| [0021](0021-storage-request-resource-lacks-name-and-bucket.md) | In Storage rules, `request.resource` has only size, contentType and metadata; reading `request.resource.name` or `.bucket` errors and denies | major | pyric | fixed (#787) |
| [0022](0022-rtdb-loose-equality-converts-types.md) | In RTDB rules, `==` and `!=` convert types in Pyric but not in production; a mixed-type comparison is allowed where production denies | major | pyric | fixed (#793) |
| [0023](0023-rtdb-rules-lint-rejects-comments.md) | `rules lint` and `rules simulate` for RTDB reject a `database.rules.json` with comments as not valid JSON; `database rules validate` accepts it | minor | @pyric/cli | fixed (#794) |
| [0024](0024-firestore-rules-validate-exits-0-on-findings.md) | `pyric firestore rules validate` exits 0 on a high-severity finding, so CI can't gate on it | minor | @pyric/cli | fixed (#786) |
| [0025](0025-storage-overwrite-evaluated-as-update.md) | In Storage rules, an upload over an existing object is evaluated as update in Pyric but create in production | major | pyric | fixed (#792) |
| [0026](0026-storage-stored-object-lacks-upload-defaults.md) | Storage stores an upload without production's contentDisposition and contentEncoding defaults | minor | pyric | fixed (#792) |
| [0027](0027-rules-grammar-has-no-bytes-literal.md) | The rules grammar has no bytes literal, so `b'...'` in a Firestore or Storage ruleset fails to parse | minor | pyric | fixed (#797) |
| [0028](0028-rtdb-simulate-unsupported-on-evaluation-error.md) | RTDB `simulate` reports UNSUPPORTED when a `.validate` expression throws, where the sandbox and production deny | minor | pyric | fixed (#795) |
| [0029](0029-rtdb-rules-created-after-start-never-load.md) | The dev server never loads a `database.rules.json` created after it starts; RTDB stays deny-all until a restart | major | @pyric/cli | fixed (#796) |
| [0030](0030-rules-string-escapes-differ-from-production.md) | Rules string literals reject the `\x`, `\u` and octal escapes production accepts, and accept the `\/` escape production rejects | minor | pyric | fixed (#798) |
| [0031](0031-rules-assembler-prints-unparseable-string.md) | The rules assembler prints a double-quoted string that contains an apostrophe as an unparseable single-quoted string | minor | pyric | fixed (#799) |
| [0032](0032-firestore-simulator-ignores-expression-budget.md) | The Firestore rules simulator allows a request that production denies for passing the 1,000-expression budget | major | pyric | open |
| [0033](0033-lint-silent-on-unbound-variable-and-unused-function.md) | Lint reports nothing for an unbound variable or an unused function, both of which production's compiler warns about | minor | pyric | open |
| [0034](0034-local-engines-accept-rulesets-production-rejects-at-compile.md) | The Firestore simulator and Storage evaluator accept rulesets production rejects at compile time (call depth, let count, nesting), and Storage denies a 21-function chain production compiles | minor | pyric | open |
| [0035](0035-simulator-set-membership-is-false.md) | In the Firestore rules simulator, `x in <set>` is false for an element the set holds | major | pyric | open |
| [0036](0036-simulator-evaluates-list-operations-production-rejects.md) | The Firestore rules simulator evaluates `list + list` and a slice with no elements, both of which production rejects as evaluation errors | major | pyric | open |
| [0037](0037-resolver-rejects-derived-set-membership-and-list-element-methods.md) | Module resolution rejects membership in a set built from request data, and a method on an element of a list built from request data | major | pyric | open |
