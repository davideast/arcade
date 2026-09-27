---
id: 0009
title: In hosted mode, each of a page's four event subscriptions replays up to 8 MiB of history, which exceeds the 24 MiB socket backlog; the socket closes with 1013 and reconnects about once a second
severity: major
package: "@pyric/cli"
pyric_commit: 87a5303e
found_in: arcade browser check under pyric({ hosted: true }) after adopting local-4
status: fixed
fixed_in: 9c125203 (#777, 9c125203)
---
## Summary

Under `pyric({ hosted: true })`, a page opens four `target: 'events'` subscriptions on its `/__pyric/sandbox` socket, and the host answers each one with the full observation history. History is bounded at 8 MiB, but the per-socket output backlog is 24 MiB, and a history batch has no operation to refuse, so the server closes the socket with 1013. The page reconnects, resubscribes all four streams, receives the same replays, and is closed again. Once history nears its bound, every page cycles about once a second even while idle. Each cut rejects the page's pending requests as `unavailable`, so game writes fail at random.

## Reproduction

From the repository root:

```bash
bash bugs/repro/0009.sh
```

The script builds a fresh Bun workspace in a temp directory with `pyric({ hosted: true })` and the vendored tarballs, starts Vite on port 5396, and fills the history with 60 writes of 100 KB documents over a socket that speaks the page's framing. It then connects with the page's own hosted client (`getHostedFirestore` from `@pyric/cli/serve/worker`, with the project key from `/__pyric/init.json`), calls `subscribeEvents` four times as a hosted page does, and counts how often the connection is interrupted in 5 s. It exits 1 on any interruption and 0 when all four subscribers receive the history on a steady connection.

In the arcade (`app/`, port 5391), the browser shows the loop directly: 13 reconnect cycles in 15 s idle and 97 in about 100 s of play. Each connection receives about 25 MB in 5 messages (four history batches of 2,866 events, about 8.38 MB each, are queued), then closes with:

```text
1013 Client output backlog exceeds 24 MiB; reconnect to resume.
```

The console repeats `WebSocket is already in CLOSING or CLOSED state` (`websocket-connection.js:124` via `:67` and `:152`): the page's `postMessage` and heartbeat call `send()` on the socket after the server's close frame arrives and before its `close` event runs.

## Expected

A page receives its history on every event subscription and the socket stays open. A full history is a normal state of a long dev session, not a reason to cut the connection.

## Actual

On local-4 (Pyric main 87a5303e):

```text
history received by 3 of 4 subscribers (events: 28, 28, 28)
connection interrupted 23 times in 5 s
```

Three 7.93 MiB replays fit under 24 MiB; the fourth does not, the host closes the socket with 1013 "Client output backlog exceeds 24 MiB; reconnect to resume.", and the client reconnects and resubscribes. With one subscription on the same history the socket stays open (1 batch, 7.93 MiB).

The fix in Pyric PR #777 (one event subscription per port) gives, on a build of that branch:

```text
history received by 4 of 4 subscribers (events: 28, 28, 28, 28)
connection interrupted 0 times in 5 s
```

## Suspected cause

Confirmed by reading and by the repro. Paths are in the Pyric repository at 87a5303e.

Where the four subscriptions come from. Each call to `subscribeEvents` (`packages/cli/src/serve/worker/client/studio.ts:36-50`) opens its own wire subscription with a new `subId`:

1. Runtime status: `packages/cli/src/serve/entries/worker-runtime.ts:166`.
2. Chip capture buffer: `packages/cli/src/serve/runtime/chip.ts:732`.
3. Chip Traffic feed: `packages/cli/src/serve/runtime/chip.ts:761-763`, subscribing at `packages/cli/src/serve/runtime/chip-traffic.ts:223`.
4. Chip Listeners mode: `packages/cli/src/serve/runtime/chip-install.ts:73-75`, subscribing at `packages/cli/src/serve/runtime/listener-mode.ts:355`.

Subscriptions 2 to 4 share one source, `sandboxEventSource` (`packages/cli/src/serve/entries/init.ts:99`, `packages/cli/src/serve/runtime/listener-event-source.ts:36-38`), which returns a fresh `subscribeEvents` per caller. The comment at `chip-install.ts:60-61` states the intent: "Traffic folds the same stream the Listeners mode does, from its own subscription".

Where history is replayed. The hosted runtime builds its sandbox with `createSandboxRoot(SERVE_HISTORY_LIMITS)` (`packages/cli/src/serve/hosted/runtime.ts:69`), which is `OBSERVATION_HISTORY_LIMITS` (`packages/pyric/src/sandbox/internal/observation-history.ts:2-5`: 10,000 events, 8 MiB). The dispatcher routes each event sub to `handleEventSub` (`packages/cli/src/serve/worker/host/dispatch.ts:339-340`), which posts `ctx.sandbox.history()` as one batch per `subId` (`packages/cli/src/serve/worker/host-events.ts:84`). In hosted mode the port's `postMessage` sends it as a `worker-message-result` (`hosted/runtime.ts:257`), and the socket's consumer writes it through `sendBridgeMessage` with no refusal callback (`packages/cli/src/bridge/server/peer.ts:77-83`).

Where the socket is cut. `sendBridgeMessage` compares `socket.bufferedAmount + payload` with `MAX_QUEUED_OPERATION_BYTES = 24 * 1024 * 1024` (`packages/cli/src/bridge/protocol.ts:60`, checked at `packages/cli/src/bridge/server/socket-message.ts:45-46`). An event batch is not a `res`, so `failBridgeResponse` returns nothing (`packages/cli/src/bridge/frame-output.ts:84-88`) and `refuseBacklogFrame` closes with 1013 (`socket-message.ts:73-75`). The four replays are posted in one burst, before the socket can drain, so four times 8 MiB always exceeds 24 MiB.

Why it loops. The page's close handler treats 1013 as resumable (`packages/cli/src/serve/worker/client/websocket-connection.ts:354-368`). `interruptConnection` rejects pending requests as `unavailable` (`:166`) and reconnects after 250 ms, because the previous attach reset `reconnectAttempt` to 0 (`:218`). On resume, `finishAttachment` calls `restoreObservationSubscriptions` (`:226`), which sends `unsub` and `sub` again for every event subscription (`packages/cli/src/serve/worker/client/core.ts:171-176`), so the four replays repeat. The console errors come from `send` (`websocket-connection.ts:136-138`) called by `postMessage` (`:81`) and the heartbeat (`:186`) on a socket the server has already closed.

Live events have the same shape: `broadcastEvents` (`host-events.ts:56-63`) sends every event once per `subId`, so each live event crosses the socket four times.

## Suggested fix and failing test

Recommended: one wire event subscription per client port. `subscribeEvents` in `packages/cli/src/serve/worker/client/studio.ts` (with `openEventSubscription` in `client/core.ts:110`) opens the wire sub on the first local subscriber, keeps the history it delivered plus live events, and replays that local copy to later subscribers in the page. The host then replays at most 8 MiB per socket, which fits the 24 MiB backlog with room for other output, and live events cross the socket once instead of four times. Resume restores one sub instead of four. The fix covers the SharedWorker runtime too, since it uses the same client.

Other options, weighed:

- Size each replay to the remaining backlog budget: keeps the socket alive but truncates history differently for each subscriber, and the fourth subscriber still gets little or nothing.
- Send replays with backpressure (wait for drain): the right general bound for pushed frames, but `post()` is synchronous down to `sendBridgeMessage`, so it needs an async queue per port in the hosted runtime. Worth doing later so a slow reader degrades instead of disconnecting.
- Cap replay bytes below 24 MiB divided by the subscription count: the count is unbounded (Studio and any app code can call `subscribeEvents`), so there is no safe constant.

Failing test first, in `packages/cli/test/serve/worker/event-stream.test.ts` or a hosted-runtime socket test: fill history past 6 MiB, open four `subscribeEvents` on one hosted client port, and assert that all four callbacks receive the full history batch and that the socket is not closed with 1013. `bugs/repro/0009.sh` is the shape. A unit test of the client alone can assert that four `subscribeEvents` calls post exactly one `{ t: 'sub', target: 'events' }` message and that a subscriber added after the first batch still receives the history.

## Workaround in pyric-games

Restart the dev server. The hosted observation history lives only in the server process's memory: the hosted runtime does not prime it from `app/.pyric/last-session.json` (only the SharedWorker boot path does, `packages/cli/src/serve/worker/serve-init.ts:661`). In the repro workspace, after filling history and restarting Vite in the same directory, the four subscriptions each received 0 events and the socket stayed open. Documents persist in `app/.pyric/state`, so a restart keeps game data. Do not delete `app/.pyric`; it is not needed and drops that data. The loop returns once play refills the history.

To avoid the loop for a whole session, `pyric({ hosted: true, runtimeChip: false })` removes the chip's three subscriptions (`chip-install.ts:46` returns before subscribing), leaving one 8 MiB replay per socket. With one subscription on a full history the repro's socket stays open. This hides the chip's Traffic and Listeners panels, so it is not applied here.

## Fixed

Fixed by Pyric PR #777, merged as 9c125203, and verified on Pyric main 9c125203 (vendored as local-5). A page now holds one event-stream subscription per port and shares it among its `subscribeEvents` callers; a subscriber that arrives after the worker's history receives the page's copy, which follows resets and reconnects. `bash bugs/repro/0009.sh` exits 0: all four subscribers receive the history (28 events each) and the connection is not interrupted in 5 s. On local-4 the same script saw 23 interruptions in 5 s.

Nothing to drop in the arcade: the workaround was to restart the dev server when the loop started.
