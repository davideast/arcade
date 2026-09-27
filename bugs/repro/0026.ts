// Repro 0026: an upload that sets no contentDisposition or contentEncoding is
// stored with production's defaults (`inline; filename*=utf-8''<file>` and
// `identity`). Pyric stores neither, so getMetadata returns them unset, and a
// metadata update's rules see null where production sees the stored defaults.
//   bun bugs/repro/0026.ts      (exit 1 while the bug is present)
import { initializeSandbox } from 'pyric/sandbox';
import { getMetadata, getStorageSandbox, ref, updateMetadata, uploadString } from 'pyric/storage';

const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow read, create: if request.auth.uid == uid;
      allow update: if request.auth.uid == uid && request.resource.contentEncoding == 'identity';
    }
  }
}`;

const box = initializeSandbox();
const storage = getStorageSandbox(box.withAuth({ uid: 'alice' }), { rules, dbName: `repro-0026-${crypto.randomUUID()}` });
const target = ref(storage, 'users/alice/a.txt');
await uploadString(target, 'hi', 'raw', { contentType: 'text/plain' });

const stored = await getMetadata(target);
console.log(`stored contentDisposition: ${JSON.stringify(stored.contentDisposition)} (production "inline; filename*=utf-8''a.txt")`);
console.log(`stored contentEncoding: ${JSON.stringify(stored.contentEncoding)} (production "identity")`);

let update = 'ALLOW';
try {
  await updateMetadata(target, { customMetadata: { note: 'x' } });
} catch {
  update = 'DENY';
}
console.log(`metadata update requiring request.resource.contentEncoding == 'identity': ${update} (production ALLOW)`);

const ok = stored.contentDisposition === "inline; filename*=utf-8''a.txt" && stored.contentEncoding === 'identity' && update === 'ALLOW';
process.exit(ok ? 0 : 1);
