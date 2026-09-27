// Repro 0025: in Storage rules, a client upload over an existing object is
// evaluated as `update` in Pyric. Production evaluates it as `create`, with
// `resource` still the stored object. So a ruleset that allows create and
// denies update lets the second upload through in production and denies it
// in Pyric.
//   bun bugs/repro/0025.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadString } from 'pyric/storage';

const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow create: if request.auth.uid == uid;
      allow update: if false;
    }
  }
}`;

const box = initializeSandbox();
const storage = getStorageSandbox(box.withAuth({ uid: 'alice' }), { rules, dbName: `repro-0025-${crypto.randomUUID()}` });
const target = ref(storage, 'users/alice/a.txt');

async function upload(body: string): Promise<'ALLOW' | 'DENY'> {
  try {
    await uploadString(target, body, 'raw', { contentType: 'text/plain' });
    return 'ALLOW';
  } catch {
    return 'DENY';
  }
}

const first = await upload('one');
const second = await upload('two');
console.log(`first upload: ${first} (production ALLOW, evaluated as create)`);
console.log(`upload over the existing object: ${second} (production ALLOW, evaluated as create)`);
process.exit(first === 'ALLOW' && second === 'ALLOW' ? 0 : 1);
