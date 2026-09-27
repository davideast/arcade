// Repro 0030: rules string literals reject escapes production accepts (\x, \u,
// octal) and accept one production rejects (\/).
//   bun bugs/repro/0030.ts      (exit 1 while the bug is present)
import { lint } from 'pyric/rules';

function ruleset(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if ${condition}; }
  }
}`;
}

const cases: Array<{ condition: string; parses: boolean }> = [
  { condition: "'\\x41' == 'A'", parses: true },
  { condition: "'\\u0041' == 'A'", parses: true },
  { condition: "'\\101' == 'A'", parses: true },
  { condition: "'\\/' == '/'", parses: false },
];
let failed = false;
for (const { condition, parses } of cases) {
  const errors = lint(ruleset(condition)).filter((issue) => issue.severity === 'error');
  const actual = errors.length === 0;
  const note = actual === parses ? '' : ` (production ${parses ? 'accepts' : 'rejects'} it)`;
  console.log(`${condition}: ${actual ? 'parses' : errors.map((e) => e.code).join(', ')}${note}`);
  if (actual !== parses) failed = true;
}
process.exit(failed ? 1 : 0);
