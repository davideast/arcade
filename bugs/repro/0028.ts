// Repro 0028: when a Realtime Database `.validate` expression throws while it
// is evaluated (a string method called on a number), the sandbox denies the
// write, as production does, but `simulate` reports UNSUPPORTED.
//   bun bugs/repro/0028.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, sandbox } from 'pyric/database';
import { rtdbRules } from 'pyric/rules';

const rules = { rules: { a: { '.write': 'auth != null', '.validate': "newData.val().toUpperCase() == 'A'" } } };

const box = initializeSandbox();
sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), rules);
let sandboxVerdict = 'ALLOW';
try {
  await set(ref(getDatabase(box.withAuth({ uid: 'u' })), 'a'), 5);
} catch {
  sandboxVerdict = 'DENY';
}
const [c] = rtdbRules(rules).simulate([{ expectation: 'DENY', operation: 'write', path: '/a', auth: 'u', newData: 5 }]).cases;
console.log(`write 5 under .validate newData.val().toUpperCase() == 'A': sandbox ${sandboxVerdict}, simulate ${c.decision} (production DENY)`);
process.exit(sandboxVerdict === 'DENY' && c.decision === 'DENY' ? 0 : 1);
