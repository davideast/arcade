// Repro 0013: the Realtime Database rules engine parses a rule's expression
// text again every time it evaluates it, so a write costs time in proportion
// to the length of the rules it evaluates, not their work. One `.write` rule,
// `auth != null` repeated with &&, 1 time and 40 times: the same meaning, 40
// times the text. Evaluation still grows with the terms (40 comparisons run),
// so the check compares a write with one parse of the rule: exit 1 while a
// 40-term write costs more than half of parsing that rule, which it does only
// while every evaluation parses again.
//   bun bugs/repro/0013.ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, sandbox } from 'pyric/database';
import { parseExpression } from 'pyric/rules/internal/rtdb';

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
const rule40 = Array.from({ length: 40 }, () => 'auth != null').join(' && ');
for (let i = 0; i < 20; i++) parseExpression(rule40);
const t = performance.now();
for (let i = 0; i < 200; i++) parseExpression(rule40);
const parse = (performance.now() - t) / 200;
console.log(`1 term: ${one.toFixed(3)} ms per write`);
console.log(`40 terms: ${forty.toFixed(3)} ms per write (${(forty / one).toFixed(1)}x)`);
console.log(`parsing the 40-term rule once: ${parse.toFixed(3)} ms`);
process.exit(forty * 2 > parse ? 1 : 0);
