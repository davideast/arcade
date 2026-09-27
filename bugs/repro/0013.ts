// Repro 0013: the Realtime Database rules engine parses a rule's expression
// text again every time it evaluates it, so a write costs time in proportion
// to the length of the rules it evaluates, not their work. One `.write` rule,
// `auth != null` repeated with &&, 1 time and 40 times: the same meaning, 40
// times the text. Exit 1 while the 40-term rule costs more than twice the
// 1-term rule per write.
//   bun bugs/repro/0013.ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, sandbox } from 'pyric/database';

async function perWrite(terms: number): Promise<number> {
  const rule = Array.from({ length: terms }, () => 'auth != null').join(' && ');
  const box = initializeSandbox();
  sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), { rules: { a: { '.write': rule } } });
  const db = getDatabase(box.withAuth({ uid: 'u' }));
  for (let i = 0; i < 20; i++) await set(ref(db, 'a'), i);
  const t = performance.now();
  for (let i = 0; i < 200; i++) await set(ref(db, 'a'), i);
  return (performance.now() - t) / 200;
}

const one = await perWrite(1);
const forty = await perWrite(40);
console.log(`1 term: ${one.toFixed(3)} ms per write`);
console.log(`40 terms: ${forty.toFixed(3)} ms per write (${(forty / one).toFixed(1)}x)`);
process.exit(forty > one * 2 ? 1 : 0);
