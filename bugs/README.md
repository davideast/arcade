# Pyric bugs found building Pyric Arcade

Each file holds one bug with its reproduction, the suspected Pyric source location, a suggested fix with its failing test, and the workaround used here. Scripts in `repro/` run from the repository root and exit 1 while the bug is present.

All eight are fixed on Pyric main 87a5303e, vendored here as local-4. Every repro exits 0 there except 0005, whose script checks the root export; that bug was in the guide, which now imports from `pyric-admin/firestore`.

0009 was found on local-4 and is open.

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
| [0009](0009-hosted-event-replays-exceed-socket-backlog.md) | In hosted mode, four event-history replays exceed the 24 MiB socket backlog; every page reconnects about once a second | major | @pyric/cli | open |
