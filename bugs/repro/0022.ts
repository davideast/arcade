// Repro 0022: in Realtime Database rules, `==` and `!=` convert types in
// Pyric and not in production. Production denies `newData.val() == '5'` when
// the number 5 is written, and `newData.val() == true` when the number 1 is
// written; Pyric allows both, in the sandbox and in `simulate`.
//   bun bugs/repro/0022.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, sandbox } from 'pyric/database';
import { rtdbRules } from 'pyric/rules';

async function write(validate: string, value: unknown): Promise<{ sandbox: string; simulate: string }> {
  const rules = { rules: { a: { '.write': 'auth != null', '.validate': validate } } };
  const box = initializeSandbox();
  sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), rules);
  let verdict = 'ALLOW';
  try {
    await set(ref(getDatabase(box.withAuth({ uid: 'u' })), 'a'), value);
  } catch {
    verdict = 'DENY';
  }
  const [c] = rtdbRules(rules).simulate([{ expectation: 'DENY', operation: 'write', path: '/a', auth: 'u', newData: value }]).cases;
  return { sandbox: verdict, simulate: c.decision };
}

// Each case is one production denied (captured against a deployed ruleset).
const cases: Array<[string, unknown]> = [
  ["newData.val() == '5'", 5],
  ['newData.val() == true', 1],
];
let failed = false;
for (const [rule, value] of cases) {
  const r = await write(rule, value);
  console.log(`${rule} with ${JSON.stringify(value)}: sandbox ${r.sandbox}, simulate ${r.simulate} (production DENY)`);
  if (r.sandbox !== 'DENY' || r.simulate !== 'DENY') failed = true;
}
// The same-type comparison is unaffected.
const same = await write("newData.val() == '5'", '5');
console.log(`newData.val() == '5' with "5": sandbox ${same.sandbox}, simulate ${same.simulate} (production ALLOW)`);
if (same.sandbox !== 'ALLOW') failed = true;
process.exit(failed ? 1 : 0);
