// Repro 0007: every rules-evaluated write re-parses the whole ruleset, so the cost
// of one write grows with the ruleset's size. Exit 1 when a write with the arcade
// ruleset costs more than a fifth of parsing it, which it does while every write
// parses. A write still costs more than with a one-rule ruleset, because the
// arcade's rules do more work.
//   bun bugs/repro/0007.ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin/firestore';
import { parseToAST } from 'pyric/rules/internal';

const big = await Bun.file(new URL('../../app/firestore.rules', import.meta.url)).text();
const tiny = "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{p=**} { allow write: if false; } } }";

async function perWrite(rules: string): Promise<number> {
  const sandbox = initializeSandbox();
  getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(rules);
  const db = getFirestore(sandbox.withAuth({ uid: 'p0' }));
  const t = performance.now();
  for (let i = 0; i < 50; i++) {
    try { await db.doc(`uno/m${i}`).set({ host: 'p0' }); } catch { /* denied */ }
  }
  return (performance.now() - t) / 50;
}

const small = await perWrite(tiny);
const large = await perWrite(big);
const t = performance.now();
for (let i = 0; i < 10; i++) parseToAST(big);
const parse = (performance.now() - t) / 10;
console.log(`one-rule ruleset: ${small.toFixed(1)} ms per write`);
console.log(`arcade ruleset (${big.length} bytes): ${large.toFixed(1)} ms per write`);
console.log(`parsing the arcade ruleset once: ${parse.toFixed(1)} ms`);
process.exit(large * 5 > parse ? 1 : 0);
