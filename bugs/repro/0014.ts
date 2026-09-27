// Repro 0014: Realtime Database rules can't use `===` or `!==`. The rule
// Firebase's own guides use for per-user data, `$uid === auth.uid`, fails to
// parse, so the sandbox denies the owner and `simulate` reports UNSUPPORTED.
// The same rule written with `==` is allowed.
//   bun bugs/repro/0014.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, sandbox } from 'pyric/database';
import { rtdbRules } from 'pyric/rules';

async function ownerWrites(rule: string): Promise<{ sandbox: string; simulate: string }> {
  const rules = { rules: { users: { $uid: { '.read': rule, '.write': rule } } } };
  const box = initializeSandbox();
  sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), rules);
  let verdict = 'ALLOW';
  try {
    await set(ref(getDatabase(box.withAuth({ uid: 'alice' })), 'users/alice'), { name: 'Alice' });
  } catch {
    verdict = 'DENY';
  }
  const [c] = rtdbRules(rules).simulate([{ expectation: 'ALLOW', operation: 'write', path: '/users/alice', auth: 'alice', newData: { name: 'Alice' } }]).cases;
  return { sandbox: verdict, simulate: `${c.decision}${c.decision === 'ALLOW' ? '' : ` (${c.reason.slice(0, 90)})`}` };
}

const results = {
  '$uid == auth.uid': await ownerWrites('$uid == auth.uid'),
  '$uid === auth.uid': await ownerWrites('$uid === auth.uid'),
  '$uid !== "nobody"': await ownerWrites('$uid !== "nobody" && $uid == auth.uid'),
};
for (const [rule, r] of Object.entries(results)) console.log(`${rule}: sandbox ${r.sandbox}, simulate ${r.simulate}`);
process.exit(Object.values(results).every((r) => r.sandbox === 'ALLOW' && r.simulate === 'ALLOW') ? 0 : 1);
