# Pyric bugs found building Pyric Arcade

Each file holds one bug with its reproduction, the suspected Pyric source location, a suggested fix with its failing test, and the workaround used here. Scripts in `repro/` run from the repository root and exit 1 while the bug is present.

| ID | Title | Severity | Package | Status |
|---|---|---|---|---|
| [0001](0001-let-bound-member-method-rejected-by-resolver.md) | Module resolution rejects a method on a member of a let-bound value (`doc.board.keys()`) | major | pyric | open |
| [0002](0002-lint-ignores-service-scope-functions.md) | Rules lint reports zero functions for resolved modular rules | major | pyric | open |
| [0003](0003-vite-plugin-cannot-prebundle-hash-deps-under-bun.md) | Under Bun workspaces, `pyric()` cannot pre-bundle js-md5 and js-sha256; the page fails to load | blocker | @pyric/cli | open |
| [0004](0004-dotted-update-path-denied-by-rules.md) | A dotted-path update is denied where the equivalent whole-map update is allowed | major | pyric | open |
| [0005](0005-test-in-node-guide-imports-missing-export.md) | The "Test in Node" guide imports `getFirestore` from `pyric-admin`, which does not export it | minor | pyric-admin | open |
