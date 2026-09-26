// Lint the resolved ruleset: bun tools/lint-rules.ts [path]
// Prints every issue and exits 1 on an error. EXPRESSION_BUDGET warnings are
// summarized: they are static estimates, and each must stay under the
// 1,000-expression runtime budget production enforces per request.
import { lint } from 'pyric/rules';

const path = process.argv[2] ?? 'app/firestore.rules';
const issues = lint(await Bun.file(path).text());
const budget = issues.filter((i) => i.code === 'EXPRESSION_BUDGET');
const others = issues.filter((i) => i.code !== 'EXPRESSION_BUDGET');

for (const i of others) console.log(`${i.severity} ${i.code}${i.line ? ` line ${i.line}` : ''}: ${i.message}`);
const estimates = budget.map((i) => Number(/~(\d+) expression nodes/.exec(i.message)?.[1] ?? 0));
const largest = Math.max(0, ...estimates);
console.log(`EXPRESSION_BUDGET: ${budget.length} rules warned, largest estimate ~${largest} of 1000`);

const errors = others.filter((i) => i.severity === 'error');
if (errors.length > 0 || largest >= 1000) process.exit(1);
