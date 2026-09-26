#!/bin/bash
# Repro 0008: when a rules reload fails, modules the new source imports are never
# watched, so fixing the module does not reload; the stale rules stay live until
# the main file is saved again. Exit 1 while the fix goes unnoticed.
#   bash bugs/repro/0008.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/.overnight/repro-0008"
mkdir -p "$DIR"
cd "$DIR"
cat > vite.config.ts <<'TS'
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';
export default defineConfig({ plugins: [pyric()] });
TS
echo '<script type="module">import "firebase/app";</script>' > index.html
cat > a.rules <<'R'
export function allowA() { return true; }
R
write_main() {
  cat > firestore.modules.rules <<R
rules_version = '2+modules';
$1
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} { allow read: if $2; }
  }
}
R
}
write_main "import { allowA } from './a';" "allowA()"

"$ROOT/node_modules/.bin/vite" --port 5398 --strictPort > vite.log 2>&1 &
PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:5398/ && break; sleep 1; done
sleep 1

# 1. Import a new module that fails to resolve (string() is rejected in modules, bug 0006).
cat > b.rules <<'R'
export function allowB() { return string(1) == '1'; }
R
write_main "import { allowA } from './a';
import { allowB } from './b';" "allowA() && allowB()"
sleep 3
# 2. Fix the module only.
cat > b.rules <<'R'
export function allowB() { return true; }
R
sleep 3
AFTER_FIX=$(grep -c "rules reloaded" vite.log)
# 3. Save the main file with no change.
touch firestore.modules.rules
sleep 3
AFTER_TOUCH=$(grep -c "rules reloaded" vite.log)
kill $PID 2>/dev/null
grep "reloaded" vite.log
echo "reloads after fixing b.rules: $AFTER_FIX; after touching the main file: $AFTER_TOUCH"
[ "$AFTER_FIX" -ge 1 ] && exit 0 || exit 1
