// Repro 0020: the Storage rules evaluator has no global int(), string() or
// float(). A call to one throws "undefined function int()", which denies
// the request, so every rule that converts a value denies.
//   bun bugs/repro/0020.ts      (exit 1 while the bug is present)
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
  const storage = getStorageSandbox(box.withAuth({ uid: 'alice' }), { rules, dbName: `repro-0020-${crypto.randomUUID()}` });
  try {
    await uploadString(ref(storage, 'users/alice/a.txt'), 'hi', 'raw', {
      contentType: 'text/plain',
      customMetadata: { moves: '12' },
    });
    return { verdict: 'ALLOW', reason: '' };
  } catch (err) {
    return { verdict: 'DENY', reason: err instanceof Error ? err.message : String(err) };
  }
}

const cases: Array<[string, 'ALLOW' | 'DENY']> = [
  ["int('12') == 12", 'ALLOW'],
  ['int(request.resource.metadata.moves) == 12', 'ALLOW'],
  ['int(2.0) == 2', 'ALLOW'],
  ["string(12) == '12'", 'ALLOW'],
  ["float('2.0') == 2.0", 'ALLOW'],
  ['float(2) == 2.0', 'ALLOW'],
  ["request.resource.metadata.moves == '12'", 'ALLOW'],
];
let ok = true;
let firstReason = '';
for (const [condition, expected] of cases) {
  const { verdict, reason } = await upload(condition);
  if (verdict !== expected) ok = false;
  if (verdict === 'DENY' && !firstReason) firstReason = reason;
  console.log(`${condition}: ${verdict} (expected ${expected})`);
}
if (firstReason) console.log(`first deny reason: ${firstReason}`);
process.exit(ok ? 0 : 1);
