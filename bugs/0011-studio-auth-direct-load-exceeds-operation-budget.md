---
id: 0011
title: In hosted Studio, a direct load of the Auth page issues one request per history event and shows "This client already has 256 pending operations." instead of the users table
severity: major
package: "@pyric/studio"
pyric_commit: 9c125203
found_in: arcade Studio check under pyric({ hosted: true }) on local-5, opening /__pyric/ui/auth/ with 19 anonymous users
status: fixed
fixed_in: dbc35150 (#785, 28d85d1e)
---
## Summary

Under `pyric({ hosted: true })`, opening Studio's Auth page directly (for example `/__pyric/ui/auth/`) shows "This client already has 256 pending operations." in place of the users table. Studio's event feed delivers the history batch to its subscribers one event at a time, and two subscribers send a request for each event: the root-collection cache sends `listRootCollections` for every event, and the Auth page's `subscribeUsers` sends `auth.listUsers` for every auth event. All of them are issued in one synchronous loop, before any response arrives, so a history of a few hundred events passes the client's 256 pending-operation budget. Every `auth.listUsers` after that point is refused, and `useAuthUsers` keeps the error even after an earlier `listUsers` succeeds. Navigating to another Studio tab and back shows the users, because by then the feed has already delivered its history and the Auth page only receives live events.

## Reproduction

From the repository root:

```bash
bash bugs/repro/0011.sh
```

The script builds a fresh Bun workspace in a temp directory with `pyric({ hosted: true })` and the vendored tarballs, and starts Vite on port 5397. It builds history the way the arcade does: 19 players sign in anonymously (one connection each), one plays 300 moves, and two more sign in, so auth events sit both before and after the writes. It then opens Studio in headless Chrome over the DevTools protocol, loads `/__pyric/ui/auth/` directly, counts the `op` frames the page sends on its socket, clicks Firestore and then Auth, and reads the Auth surface each time. It exits 1 when the direct load shows the error and 0 when it shows the users table. Chrome must be installed; set `CHROME` to its binary if it is not at the default macOS path.

In the arcade (`app/`, port 5392), opening `http://localhost:5392/__pyric/ui/auth/` with 19 anonymous users shows the error; clicking Firestore and then Auth shows the users.

## Expected

A direct load of the Auth page shows the users table. Loading Studio sends a bounded number of requests no matter how long the history is.

## Actual

On Pyric main 9c125203 (local-5):

```text
history: 642 events (42 auth), 21 anonymous users
direct load of /__pyric/ui/auth/: error (This client already has 256 pending operations.)
ops sent on the socket during the load: {"presence.register":1,"listRootCollections":217,"auth.listUsers":39}; most pending at once: 256
after Firestore then Auth: users table (anonymous)
workspace: <tmp>/auth-burst-repro
```

The page sends exactly 256 operations before the first response (217 `listRootCollections` and 39 `auth.listUsers`); every later request in the burst is refused on the client and never reaches the socket. The header still reads "users · 21", because the accepted `listUsers` calls set the user list, but the list area shows the refusal.

Where the auth events sit in the history decides the outcome. With the same server after 19 sign-ins followed by 300 writes (638 events, every auth event among the first 38), the direct load showed the table: the burst passed 256 only on `listRootCollections` calls, which fail silently. Adding two sign-ins after the writes put auth events past the budget point, and the next direct load showed the error. A long arcade session interleaves sign-ins with thousands of game writes, so it always has auth events late in the history.

## Suspected cause

Confirmed by reading and by the repro. Paths are in the Pyric repository at 9c125203.

Where the burst comes from. `workerEventFeed` (`packages/studio/src/clients/worker-live.ts:278`) opens one event subscription and, for the first batch (the full history), calls every subscriber once per event (`worker-live.ts:304-305`). Two subscribers turn each call into a request:

1. `useWorkerRootCollections` (`packages/studio/src/shell/studio-data.ts:130`) subscribes with `live.feed.subscribe(() => refresh())` (`studio-data.ts:156`), and `refresh` sends `listRootCollections` without checking for a request in flight. Every component that calls `useStudioDataSource` (`studio-data.ts:84`) gets its own copy: the shell's `StatusCluster` (`packages/studio/src/shell/StatusCluster.tsx:71`) and the Auth page itself (`packages/studio/src/features/auth/AuthSurface.tsx:107`).
2. The served `authApi.subscribeUsers` (`worker-live.ts:459-461`) calls its callback for every `service_mutation` event with `service === 'auth'`, and `useAuthUsers` passes `relist` as that callback (`packages/ui/src/auth/hooks/useAuthUsers.ts:88`, `:103`), which sends `auth.listUsers` each time.

Where the limit is counted. `rawRpc` (`packages/cli/src/serve/worker/client/core.ts:571`) reserves each `op` against a budget shared by the port's pending requests (`core.ts:579`, `operationBudget` at `:602`) and rejects the request at once when it is refused (`core.ts:582`). The budget refuses the 257th pending operation with this message (`packages/cli/src/bridge/operation-budget.ts:16-18`, `MAX_PENDING_OPERATIONS = 256` at `packages/cli/src/bridge/protocol.ts:57`). The hosted runtime counts the same limit per port on the server (`packages/cli/src/serve/hosted/runtime.ts:265-275`), but the client refuses first, so the socket carries at most 256.

Why the error stays. The refusals reject in a microtask, before any response from the server, so `applyErr` sets the error (`useAuthUsers.ts:78-81`). When the accepted `listUsers` calls resolve, `applyUsers` (`useAuthUsers.ts:73`) sets the users but does not clear `error`, and the list renders the error.

Why a later visit works. `StatusCluster` is mounted on every Studio route and holds feed subscriptions (`useStudioEvents` at `StatusCluster.tsx:56` and `useStudioDataSource` at `:71`), so the feed's event subscription and its delivered history survive the route change. When the Auth page mounts again, its `subscribeUsers` joins a feed whose history was already delivered and receives only live events (`worker-live.ts:311-317`). Its effect also resets `error` on mount. The page then lists users once on mount and shows the table.

## Suggested fix and failing test

Recommended: coalesce feed-driven refreshes so each subscriber has at most one request in flight. In `useWorkerRootCollections` and in the served `subscribeUsers` (or in `useAuthUsers`'s `relist`), mark the view dirty when an event arrives, send a request only when none is pending, and send one more when it resolves if events arrived in the meantime. A history batch of any length then costs one or two requests per subscriber, and live bursts (a game's fast writes) stop costing one request each too. Also clear `error` in `applyUsers` so a transient failure does not outlive a later successful list.

Other options, weighed:

- Deliver the history batch to each subscriber as one call instead of one call per event: fixes the direct load, but a burst of live events still fans out one request each.
- Raise `MAX_PENDING_OPERATIONS`: the history bound is 10,000 events, so any constant below that still fails, and the budget exists to bound a client.
- Skip the history batch in `subscribeUsers` and `useWorkerRootCollections`: both already fetch on mount, but it relies on every future subscriber knowing the history is stale.

Failing tests first:

- `packages/studio/src/clients/worker-live.test.ts`: build a feed over a fake `subscribeEvents` whose first batch holds 600 events with auth `service_mutation` events after position 300, subscribe `authApi.subscribeUsers` with a counting `listUsers`, and assert it is called at most twice. The same shape for `useWorkerRootCollections` asserts at most two `listRootCollections` calls.
- `packages/ui/test/auth/hooks/useAuthUsers.test.tsx`: with an `AuthApiProvider` whose `listUsers` rejects once and then resolves, trigger two relists and assert the hook ends with the users and `error` undefined.

`bugs/repro/0011.sh` drives the real page end to end and exits 0 once a direct load shows the table.

## Workaround in pyric-games

Open another Studio tab first (confirmed with Firestore), then click Auth. The header, mounted on every tab, keeps the event feed open across tabs, so the Auth page skips the history replay and loads normally. Reloading the Auth page itself does not help; it replays the history again.

Restarting the dev server also clears it for a while: the hosted observation history lives only in the server process (see 0009's workaround), so a fresh server starts with an empty history and a direct load works until a few hundred events, with sign-ins among the later ones, have accumulated. Documents and users persist in `app/.pyric/state`. Nothing in the arcade's code is involved, so there is no code workaround to apply here.

## Fixed

Fixed by Pyric PR #785, merged as 28d85d1e, and verified on Pyric main dbc35150 (vendored as local-6). Studio now coalesces the feed-driven `listRootCollections` and `listUsers` reads, and a successful user list clears the Auth error. `bash bugs/repro/0011.sh` exits 0: a direct load of the Auth page sends one `presence.register`, two `listRootCollections` and two `auth.listUsers` operations, with at most 3 pending at once, and the users table shows after Firestore then Auth.

Nothing to drop in the arcade: the workaround was to open another Studio tab first or restart the dev server.
