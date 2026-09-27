// Repro 0016: Realtime Database lint reports HARDCODED_FALSE (or _TRUE) for
// any boolean literal in a rule, including a comparison such as
// `data.child('open').val() == false`. And every RTDB issue carries origin
// 'validate': a PARSE_ERROR is not marked 'parse', a hardcoded-rule warning
// is not marked 'lint', and nothing says which rule (.read, .write,
// .validate) it came from.
//   bun bugs/repro/0016.ts      (exit 1 while the bug is present)
import { rtdbRules } from 'pyric/rules';

const show = (issues: { code: string; origin: string }[]) => issues.map((i) => `${i.code} (origin ${i.origin})`).join(', ') || 'no issues';
const comparison = rtdbRules({ paths: { '/rooms/$id': { write: "auth != null && data.child('open').val() == false" } } }).lint();
const denyAll = rtdbRules({ paths: { '/rooms/$id': { read: 'false', write: 'false' } } }).lint();
const unparsed = rtdbRules({ paths: { '/rooms/$id': { write: 'auth != null && (' } } }).lint();

console.log(`write rule comparing a value to false: ${show(comparison)}`);
console.log(`read and write rules that are false: ${show(denyAll)}`);
console.log(`write rule that does not parse: ${show(unparsed)}`);
const falsePositive = comparison.some((i) => i.code.startsWith('HARDCODED_'));
const wrongOrigin = denyAll.some((i) => i.origin !== 'lint') || unparsed.some((i) => i.origin !== 'parse');
process.exit(falsePositive || wrongOrigin ? 1 : 0);
