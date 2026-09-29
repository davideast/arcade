// Repro 0038: the EXPRESSION_BUDGET estimate is below production's count for
// a rule whose ternaries take their false branch. Production charges a
// ternary 2 more when it takes the false branch; the estimate does not, so a
// rule production stops at the 1,000-expression limit lints silent.
//   bun bugs/repro/0038.ts      (exit 1 while the bug is present)
import { lint } from 'pyric/rules';

// 90 conjuncts, each a ternary whose condition is false when `a` is 0.
// Production (Rules Test API, digame-mas): with a == 0 the request is denied
// at the limit ("Unable to evaluate the expression as the maximum of 1000
// expressions to evaluate has been reached."); with a == 1 it is allowed,
// at 898 expressions.
const terms = Array.from({ length: 90 }, () => '(resource.data.a == 1 ? true : true)').join(' && ');
const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow get: if ${terms};
    }
  }
}`;

const budget = lint(source).filter((issue) => issue.code === 'EXPRESSION_BUDGET');
const estimate = Math.max(0, ...budget.map((issue) => Number(/~(\d+) expression/.exec(issue.message)?.[1] ?? 0)));
console.log(
  `90 false-branch ternaries: lint estimate ${estimate > 0 ? `~${estimate}` : 'none'}; `
  + 'production DENY at the 1000-expression limit when every ternary takes its false branch',
);
process.exit(estimate >= 1000 ? 0 : 1);
