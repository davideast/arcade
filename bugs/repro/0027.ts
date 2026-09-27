// Repro 0027: the rules grammar has no bytes literal, so `b'abc'` in a
// Firestore or Storage ruleset fails to parse. The same bytes built with
// `'abc'.toUtf8()` parse.
//   bun bugs/repro/0027.ts      (exit 1 while the bug is present)
import { lint } from 'pyric/rules';

function ruleset(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if ${condition}; }
  }
}`;
}

const cases = ["b'abc' == 'abc'.toUtf8()", "b'\\x00\\x01'.size() == 2", "'abc'.toUtf8() == 'abc'.toUtf8()"];
let failed = false;
for (const condition of cases) {
  const errors = lint(ruleset(condition)).filter((issue) => issue.severity === 'error');
  console.log(`${condition}: ${errors.length === 0 ? 'parses' : errors.map((e) => e.code).join(', ')}`);
  if (errors.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
