// Repro 0031: the rules assembler prints a double-quoted string that contains
// an apostrophe as a single-quoted string without escaping it, so the printed
// ruleset does not parse. The module resolver and trace text use this printer.
//   bun bugs/repro/0031.ts      (exit 1 while the bug is present)
import { assembleRules, parseToASTOrError } from 'pyric/rules/internal';

const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if resource.data.s == "it's"; }
  }
}`;

const parsed = parseToASTOrError(source);
if (!parsed.ok) {
  console.log('source did not parse');
  process.exit(1);
}
const printed = assembleRules(parsed.ast);
const line = printed.split('\n').find((l) => l.includes('allow read'))?.trim();
const reparsed = parseToASTOrError(printed);
console.log(`printed: ${line}`);
console.log(`printed ruleset ${reparsed.ok ? 'parses' : 'does not parse'}`);
process.exit(reparsed.ok ? 0 : 1);
