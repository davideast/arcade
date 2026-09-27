// Repro 0012: a Realtime Database write evaluates the `.validate` rule of an
// unchanged sibling node. `/rooms/r1/count` may only change by +1; a write to
// `/rooms/r1/title` leaves count as it is and has nothing to validate there,
// but the sandbox and `simulate` deny it because count's rule fails on the
// unchanged value.
//   bun bugs/repro/0012.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, sandbox } from 'pyric/database';
import { rtdbRules } from 'pyric/rules';

const rules = {
  rules: {
    rooms: {
      $room: {
        title: { '.write': 'auth != null', '.validate': 'newData.isString()' },
        count: { '.write': 'auth != null', '.validate': 'newData.val() == data.val() + 1' },
      },
    },
  },
};

const box = initializeSandbox();
const admin = getDatabase(box.withAuth({ uid: 'admin' }));
sandbox.setRules(admin, rules);
sandbox.setData(admin, { '/rooms/r1/count': 1 });
const db = getDatabase(box.withAuth({ uid: 'alice' }));

let sandboxAllows = true;
try {
  await set(ref(db, 'rooms/r1/title'), 'lobby');
} catch (e) {
  sandboxAllows = false;
  console.log(`sandbox: ${(e as Error).message}`);
}
const [simulated] = rtdbRules(rules).simulate([{
  expectation: 'ALLOW',
  operation: 'write',
  path: '/rooms/r1/title',
  auth: 'alice',
  data: { rooms: { r1: { count: 1 } } },
  newData: 'lobby',
}]).cases;
console.log(`sandbox: write to /rooms/r1/title ${sandboxAllows ? 'ALLOWED' : 'DENIED'}`);
console.log(`simulate: ${simulated.decision} (${simulated.matchedPath}: ${simulated.reason})`);
process.exit(sandboxAllows && simulated.decision === 'ALLOW' ? 0 : 1);
