#!/bin/bash
# Repro 0011: in served Studio under pyric({ hosted: true }), loading the Auth
# page directly shows "This client already has 256 pending operations." The
# page's event feed fans the whole history batch out to every subscriber, and
# two of them issue one request per event (listRootCollections for any event,
# auth.listUsers for each auth event), so a few hundred events of history
# exceed the client's 256 pending-operation budget in one synchronous burst.
# Exit 1 while a direct load of the Auth page shows the error.
#   bash bugs/repro/0011.sh
# Needs Google Chrome (set CHROME to its binary if it is not in /Applications).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT=5397
CDP=9337
DIR="$(mktemp -d)/auth-burst-repro"
mkdir -p "$DIR/app/src" "$DIR/vendor"
cp "$ROOT"/vendor/pyric/pyric-local-*.tgz "$DIR/vendor/pyric.tgz"
cp "$ROOT"/vendor/pyric/pyric-cli-local-*.tgz "$DIR/vendor/pyric-cli.tgz"
cp "$ROOT"/vendor/pyric/pyric-ui-local-*.tgz "$DIR/vendor/pyric-ui.tgz"
cat > "$DIR/package.json" <<'JSON'
{
  "name": "auth-burst-repro",
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
    match /moves/{id} { allow read, write: if true; }
  }
}
R
echo '<script type="module" src="/src/main.ts"></script>' > "$DIR/app/index.html"
echo "import { initializeApp } from 'firebase/app'; initializeApp({ projectId: 'demo' });" > "$DIR/app/src/main.ts"

# Step 1: build history the way the arcade does. 19 players sign in
# anonymously (one connection each, like 19 browsers), play 300 moves, and two
# more players sign in, so auth events sit both before and after the writes.
cat > "$DIR/fill.ts" <<'TS'
const url = process.argv[2]!;
const w = await import('@pyric/cli/serve/worker');
const init = await (await fetch(new URL('/__pyric/init.json', url.replace(/^ws/, 'http')))).json() as { projectKey: string };
async function player(moves: number): Promise<void> {
  const db = w.getHostedFirestore({ url, projectKey: init.projectKey });
  db.port.postMessage({ t: 'appConfig', options: { projectId: 'demo', apiKey: 'k', appId: 'a' } });
  const { user } = await w.signInAnonymously(w.getAuth(db));
  for (let j = 0; j < moves; j++) await w.setDoc(w.doc(db, `moves/m${j % 20}`), { n: j, by: user.uid });
}
for (let i = 0; i < 18; i++) await player(0);
await player(300);
await player(0);
await player(0);
const db = w.getHostedFirestore({ url, projectKey: init.projectKey });
db.port.postMessage({ t: 'appConfig', options: { projectId: 'demo', apiKey: 'k', appId: 'a' } });
const history = await new Promise<{ kind: string; service?: string }[]>((resolve) => w.subscribeEvents(db, resolve));
const auth = history.filter((e) => e.kind === 'service_mutation' && e.service === 'auth').length;
console.log(`history: ${history.length} events (${auth} auth), 21 anonymous users`);
process.exit(0);
TS

# Step 2: open Studio's Auth page in headless Chrome over the DevTools
# protocol, directly and then after visiting Firestore. A hook installed before
# the page's scripts counts the op frames the page sends on its socket.
cat > "$DIR/studio.ts" <<'TS'
const [origin, cdp] = process.argv.slice(2) as [string, string];
const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string };
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
let next = 0;
const waiting = new Map<number, (value: any) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id !== undefined) waiting.get(m.id)?.(m.result);
};
function send(method: string, params: object = {}): Promise<any> {
  const id = ++next;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => waiting.set(id, resolve));
}
async function evaluate(expression: string): Promise<any> {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result.value;
}
const hook = `(() => {
  const log = window.__ops = { sent: {}, maxPending: 0 };
  const pending = new Set();
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      const m = JSON.parse(data).message;
      if (m && m.t === 'op') { log.sent[m.method] = (log.sent[m.method] || 0) + 1; pending.add(m.id); log.maxPending = Math.max(log.maxPending, pending.size); }
      if (!this.__counted) {
        this.__counted = true;
        this.addEventListener('message', (e) => { try { const r = JSON.parse(e.data).message; if (r && r.t === 'res') pending.delete(r.id); } catch {} });
      }
    } catch {}
    return send.call(this, data);
  };
})()`;
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: hook });
const settle = (ms: number) => evaluate(`new Promise((r) => setTimeout(r, ${ms}))`);
const surface = `(document.querySelector('[data-pyric-ui="auth-surface"]') || document.body).innerText`;

await send('Page.navigate', { url: `${origin}/__pyric/ui/auth/` });
await new Promise((r) => setTimeout(r, 1000));
await settle(5000);
const direct: string = await evaluate(surface);
const ops = await evaluate('window.__ops');

await evaluate(`[...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Firestore').click()`);
await settle(2000);
await evaluate(`[...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Auth').click()`);
await settle(3000);
const after: string = await evaluate(surface);

const ERROR = 'This client already has 256 pending operations.';
const firstLine = (text: string) => text.split('\n').find((l) => l.includes(ERROR) || l.startsWith('anonymous')) ?? text.slice(0, 80);
console.log(`direct load of /__pyric/ui/auth/: ${direct.includes(ERROR) ? 'error' : 'users table'} (${firstLine(direct)})`);
console.log(`ops sent on the socket during the load: ${JSON.stringify(ops.sent)}; most pending at once: ${ops.maxPending}`);
console.log(`after Firestore then Auth: ${after.includes(ERROR) ? 'error' : 'users table'} (${firstLine(after)})`);
process.exit(direct.includes(ERROR) ? 1 : 0);
TS

(cd "$DIR" && bun install > install.log 2>&1)
cd "$DIR/app"
../node_modules/.bin/vite --port $PORT --strictPort > vite.log 2>&1 &
VITE=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:$PORT/ && break; sleep 1; done
bun "$DIR/fill.ts" ws://localhost:$PORT/__pyric/sandbox
"$CHROME" --headless=new --remote-debugging-port=$CDP --user-data-dir="$DIR/chrome" --no-first-run about:blank > "$DIR/chrome.log" 2>&1 &
BROWSER=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:$CDP/json/version && break; sleep 1; done
bun "$DIR/studio.ts" http://localhost:$PORT http://127.0.0.1:$CDP
STATUS=$?
kill $BROWSER $VITE 2>/dev/null
echo "workspace: $DIR"
exit $STATUS
