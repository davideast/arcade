#!/bin/bash
# Repro 0003: in a Bun workspace (isolated installs), the pyric() Vite plugin's
# optimizeDeps.include of 'js-md5' and 'js-sha256' does not resolve from the app,
# so Vite serves the CommonJS file raw and the page throws
#   SyntaxError: ... does not provide an export named 'md5'
# Usage: bash bugs/repro/0003.sh   (exit 1 while the bug is present)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(mktemp -d)/md5-repro"
mkdir -p "$DIR/app/src" "$DIR/vendor"
cp "$ROOT"/vendor/pyric/pyric-local-*.tgz "$DIR/vendor/pyric.tgz"
cp "$ROOT"/vendor/pyric/pyric-cli-local-*.tgz "$DIR/vendor/pyric-cli.tgz"
cp "$ROOT"/vendor/pyric/pyric-ui-local-*.tgz "$DIR/vendor/pyric-ui.tgz"
cat > "$DIR/package.json" <<'JSON'
{
  "name": "md5-repro",
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
export default defineConfig({ plugins: [pyric()] });
TS
echo '<script type="module" src="/src/main.ts"></script>' > "$DIR/app/index.html"
echo "import { initializeApp } from 'firebase/app'; initializeApp({ projectId: 'demo' });" > "$DIR/app/src/main.ts"
(cd "$DIR" && bun install > install.log 2>&1)
cd "$DIR/app"
../node_modules/.bin/vite --port 5399 --strictPort > vite.log 2>&1 &
PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:5399/ && break; sleep 1; done
sleep 2
kill $PID 2>/dev/null
echo "workspace: $DIR"
if grep -q "Failed to resolve dependency: js-md5" vite.log; then
  grep "Failed to resolve dependency" vite.log
  exit 1
fi
echo "js-md5 and js-sha256 pre-bundled"
exit 0
