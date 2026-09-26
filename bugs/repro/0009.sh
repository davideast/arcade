#!/bin/bash
# Repro 0009: under pyric({ hosted: true }), every event subscription on a page's
# socket replays the full observation history (up to 8 MiB each). A page opens
# four, so a full history exceeds the 24 MiB per-socket output backlog and the
# server closes the socket with 1013. The page reconnects, resubscribes, and loops.
# Exit 1 while the socket is closed with 1013.
#   bash bugs/repro/0009.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(mktemp -d)/backlog-repro"
mkdir -p "$DIR/app/src" "$DIR/vendor"
cp "$ROOT"/vendor/pyric/pyric-local-*.tgz "$DIR/vendor/pyric.tgz"
cp "$ROOT"/vendor/pyric/pyric-cli-local-*.tgz "$DIR/vendor/pyric-cli.tgz"
cp "$ROOT"/vendor/pyric/pyric-ui-local-*.tgz "$DIR/vendor/pyric-ui.tgz"
cat > "$DIR/package.json" <<'JSON'
{
  "name": "backlog-repro",
  "private": true,
  "workspaces": ["app"],
  "overrides": {
    "pyric": "file:./vendor/pyric.tgz",
    "@pyric/cli": "file:./vendor/pyric-cli.tgz",
    "@pyric/ui": "file:./vendor/pyric-ui.tgz"
  },
  "devDependencies": {
    "pyric": "file:./vendor/pyric.tgz",
    "@pyric/cli": "file:./vendor/pyric-cli.tgz",
    "@pyric/ui": "file:./vendor/pyric-ui.tgz",
    "firebase": "^12.12.0",
    "vite": "^6.0.0"
  }
}
JSON
cat > "$DIR/app/package.json" <<'JSON'
{ "name": "app", "private": true, "type": "module" }
JSON
cat > "$DIR/app/vite.config.ts" <<'TS'
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';
export default defineConfig({ plugins: [pyric({ hosted: true })] });
TS
cat > "$DIR/app/firestore.rules" <<'R'
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /blobs/{id} { allow read, write: if true; }
  }
}
R
echo '<script type="module" src="/src/main.ts"></script>' > "$DIR/app/index.html"
echo "import { initializeApp } from 'firebase/app'; initializeApp({ projectId: 'demo' });" > "$DIR/app/src/main.ts"

# The socket client. It speaks the page's framing (websocket-connection.ts):
# attach, appConfig, then worker-message frames carrying worker port messages.
cat > "$DIR/client.ts" <<'TS'
const url = process.argv[2]!;

function attach(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port', clientInfo: { platform: 'browser' } }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type !== 'attach-ack') return;
      ws.onmessage = null;
      ws.send(JSON.stringify({ type: 'worker-message', message: { t: 'appConfig', options: { projectId: 'demo', apiKey: 'k', appId: 'a' } } }));
      resolve(ws);
    };
    ws.onerror = () => reject(new Error('socket error'));
  });
}

// 1. Fill the observation history: 60 writes of 100 KB documents. Each request
//    event carries the document, so history reaches its 8 MiB bound.
const writer = await attach();
const blob = 'x'.repeat(100 * 1024);
await new Promise<void>((resolve) => {
  let done = 0;
  writer.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.message?.t === 'res' && ++done === 60) resolve();
  };
  for (let i = 0; i < 60; i++) {
    writer.send(JSON.stringify({ type: 'worker-message', message: { t: 'op', id: `w${i}`, method: 'setDoc', path: `blobs/b${i % 20}`, data: { i, blob } } }));
  }
});
writer.close();

// 2. Attach a second socket and open four event subscriptions, as a hosted page does
//    (runtime status, chip capture, chip traffic, chip listeners).
const ws = await attach();
const batches: number[] = [];
let bytes = 0;
ws.onmessage = (e) => {
  const s = String(e.data);
  bytes += s.length;
  const m = JSON.parse(s);
  if (m.message?.t === 'event') batches.push(m.message.events.length);
};
for (let i = 1; i <= 4; i++) {
  ws.send(JSON.stringify({ type: 'worker-message', message: { t: 'sub', subId: `events-${i}`, target: 'events' } }));
}
const closed = await new Promise<{ code: number; reason: string } | null>((resolve) => {
  ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  setTimeout(() => resolve(null), 5000);
});
console.log(`history batches received: ${batches.length} (events per batch: ${batches.join(', ') || 'none'}), ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
if (closed) {
  console.log(`socket closed: ${closed.code} ${closed.reason}`);
  process.exit(closed.code === 1013 ? 1 : 2);
}
console.log('socket still open after 5 s');
ws.close();
process.exit(batches.length === 4 ? 0 : 2);
TS

(cd "$DIR" && bun install > install.log 2>&1)
cd "$DIR/app"
../node_modules/.bin/vite --port 5396 --strictPort > vite.log 2>&1 &
PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:5396/ && break; sleep 1; done
bun "$DIR/client.ts" ws://localhost:5396/__pyric/sandbox
STATUS=$?
kill $PID 2>/dev/null
echo "workspace: $DIR"
exit $STATUS
