// Repro 0019: in Storage rules, `+` on two strings evaluates to undefined
// instead of their concatenation. A rule comparing a built path with `==`
// denies every request, and one comparing it with `!=` allows every request.
//   bun bugs/repro/0019.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadString } from 'pyric/storage';

async function upload(condition: string): Promise<'ALLOW' | 'DENY'> {
  const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow create: if ${condition};
    }
  }
}`;
  const box = initializeSandbox();
  const storage = getStorageSandbox(box.withAuth({ uid: 'alice' }), { rules, dbName: `repro-0019-${crypto.randomUUID()}` });
  try {
    await uploadString(ref(storage, 'users/alice/a.txt'), 'hi', 'raw', { contentType: 'text/plain' });
    return 'ALLOW';
  } catch {
    return 'DENY';
  }
}

const cases: Array<[string, 'ALLOW' | 'DENY']> = [
  ["'a' + 'b' == 'ab'", 'ALLOW'],
  ["'users/' + uid + '/' + file == 'users/alice/a.txt'", 'ALLOW'],
  ["'a' + 'b' != 'ab'", 'DENY'],
  ["'users/' + request.auth.uid != 'users/alice'", 'DENY'],
  // Production has no list + list in Storage rules: it is an unsupported-operation error, which denies.
  ['[1] + [2] == [1, 2]', 'DENY'],
  ['1 + 2 == 3', 'ALLOW'],
];
let ok = true;
for (const [condition, expected] of cases) {
  const actual = await upload(condition);
  if (actual !== expected) ok = false;
  console.log(`${condition}: ${actual} (expected ${expected})`);
}
process.exit(ok ? 0 : 1);
