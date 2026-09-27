// Repro 0021: in Storage rules, request.resource carries only size,
// contentType and metadata. Reading request.resource.name or
// request.resource.bucket is an absent-property error, so the rule denies.
//   bun bugs/repro/0021.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadString } from 'pyric/storage';

async function upload(condition: string): Promise<{ verdict: 'ALLOW' | 'DENY'; reason: string }> {
  const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow create: if ${condition};
    }
  }
}`;
  const box = initializeSandbox();
  const storage = getStorageSandbox(box.withAuth({ uid: 'alice' }), { rules, dbName: `repro-0021-${crypto.randomUUID()}` });
  try {
    await uploadString(ref(storage, 'users/alice/a.txt'), 'hi', 'raw', { contentType: 'text/plain' });
    return { verdict: 'ALLOW', reason: '' };
  } catch (err) {
    return { verdict: 'DENY', reason: err instanceof Error ? err.message : String(err) };
  }
}

const cases: Array<[string, 'ALLOW' | 'DENY']> = [
  ["request.resource.name == 'users/alice/a.txt'", 'ALLOW'],
  ["request.resource.name.split('/')[1] == request.auth.uid", 'ALLOW'],
  ['request.resource.bucket == bucket', 'ALLOW'],
  ["request.resource.name != 'users/alice/a.txt'", 'DENY'],
  ["request.resource.size == 2 && request.resource.contentType == 'text/plain'", 'ALLOW'],
];
let ok = true;
let firstReason = '';
for (const [condition, expected] of cases) {
  const { verdict, reason } = await upload(condition);
  if (verdict !== expected) ok = false;
  if (verdict === 'DENY' && expected === 'ALLOW' && !firstReason) firstReason = reason;
  console.log(`${condition}: ${verdict} (expected ${expected})`);
}
if (firstReason) console.log(`first deny reason: ${firstReason}`);
process.exit(ok ? 0 : 1);
