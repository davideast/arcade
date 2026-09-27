// Repro 0018: `simulate` reports UNSUPPORTED for a Realtime Database request
// that the rules deny, when the deepest rules node on the requested path has
// no rule of the request's kind (it has only children, or only a .validate):
// the ancestors' rules evaluate to false, and it answers "No 'write' rule
// found" instead of DENY. The sandbox denies the same request.
//   bun bugs/repro/0018.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, get, ref, set, sandbox } from 'pyric/database';
import { rtdbRules } from 'pyric/rules';

const rules = {
  rules: {
    '.read': false,
    '.write': false,
    rooms: { $id: { '.read': 'auth != null', '.write': "auth != null && newData.child('n').val() < 10", n: { '.validate': 'newData.isNumber()' } } },
  },
};
const box = initializeSandbox();
sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), rules);
const db = getDatabase(box.withAuth({ uid: 'alice' }));

const requests = [
  { label: 'write /rooms/r1/n = 50 (the room .write is false; n has only a .validate)', operation: 'write' as const, path: '/rooms/r1/n', newData: 50, run: () => set(ref(db, 'rooms/r1/n'), 50) },
  { label: 'write /elsewhere (only the root rule, false)', operation: 'write' as const, path: '/elsewhere', newData: 1, run: () => set(ref(db, 'elsewhere'), 1) },
  { label: 'read /rooms (only the root rule, false)', operation: 'read' as const, path: '/rooms', newData: undefined, run: () => get(ref(db, 'rooms')) },
];
let agree = true;
for (const r of requests) {
  let verdict = 'ALLOW';
  try {
    await r.run();
  } catch {
    verdict = 'DENY';
  }
  const [c] = rtdbRules(rules).simulate([{ expectation: 'DENY', operation: r.operation, path: r.path, auth: 'alice', ...(r.newData === undefined ? {} : { newData: r.newData }) }]).cases;
  console.log(`${r.label}: sandbox ${verdict}, simulate ${c.decision}${c.decision === 'DENY' ? '' : ` (${c.reason})`}`);
  if (verdict !== 'DENY' || c.decision !== 'DENY') agree = false;
}
process.exit(agree ? 0 : 1);
