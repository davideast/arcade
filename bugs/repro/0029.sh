#!/bin/bash
# Repro 0029: the dev server reads database.rules.json once at startup. When the
# file does not exist then, creating it later is never noticed, and RTDB stays
# deny-all until the server restarts. Changing an existing file does reload.
# Exit 1 while creating the file goes unnoticed.
#   bash bugs/repro/0029.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/.overnight/repro-0029"
mkdir -p "$DIR"
cd "$DIR"
cat > vite.config.ts <<'TS'
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';
export default defineConfig({ plugins: [pyric()] });
TS
echo '<script type="module">import "firebase/app";</script>' > index.html
cat > firestore.rules <<'R'
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} { allow read: if true; }
  }
}
R
# Start with no RTDB rules file.
mv -f database.rules.json database.rules.json.previous 2>/dev/null || true

"$ROOT/node_modules/.bin/vite" --port 5399 --strictPort > vite.log 2>&1 &
PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:5399/ && break; sleep 1; done
sleep 1

# Create the rules file after startup, as a branch switch or a first `rtdb:rules` run does.
cat > database.rules.json <<'J'
{ "rules": { "notes": { ".read": "auth != null", ".write": "auth != null" } } }
J
sleep 3
kill $PID 2>/dev/null
wait $PID 2>/dev/null

grep -E "no database.rules.json found|rtdb rules" vite.log | sed 's/^ *//'
if grep -q "rtdb rules reloaded" vite.log; then
  echo "creating database.rules.json after startup: reloaded"
  exit 0
fi
echo "creating database.rules.json after startup: never loaded (RTDB stays deny-all)"
exit 1
