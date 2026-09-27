// Repro 0032: the Firestore rules simulator does not enforce production's
// runtime budget of 1,000 evaluated expressions per request. A request whose
// rule evaluates more than that is denied in production ("Unable to evaluate
// the expression as the maximum of 1000 expressions to evaluate has been
// reached"); the simulator reports ALLOW.
//   bun bugs/repro/0032.ts      (exit 1 while the bug is present)
import { firestoreRules } from 'pyric/rules';

// Twelve functions of 90 comparisons each, all true: about 1,080 comparisons
// plus the calls, past the budget, and under the 98-term chain compile limit.
const terms = Array.from({ length: 90 }, () => 'request.resource.data.a == 1').join(' && ');
const fns = Array.from({ length: 12 }, (_, i) => `function f${i}() { return ${terms}; }`).join('\n    ');
const calls = Array.from({ length: 12 }, (_, i) => `f${i}()`).join(' && ');
const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${fns}
    match /docs/{id} { allow create: if ${calls}; }
  }
}`;

const summary = firestoreRules(source).simulate([
  { description: 'over budget', expectation: 'DENY', method: 'create', path: 'docs/d1', auth: { uid: 'u' }, data: { a: 1 } },
]);
const [c] = summary.cases;
const evaluated = c.trace?.length ?? 0;
console.log(`about 1,080 comparisons in one request: simulate ${c.decision} (${evaluated} trace nodes); production DENY at 1000 expressions`);
process.exit(c.decision === 'DENY' ? 0 : 1);
