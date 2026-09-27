// Repro 0033: lint reports nothing for an unbound variable or an unused
// function. Production's compiler reports both as warnings ("Invalid variable
// name: d." and an unused-function warning), and the unbound variable denies
// every request that reaches it.
//   bun bugs/repro/0033.ts      (exit 1 while the bug is present)
import { lint } from 'pyric/rules';

const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function neverCalled() { return request.auth != null; }
    match /games/{id} {
      allow create: if request.auth != null && d.a1 == 'R';
    }
  }
}`;

const issues = lint(source);
const unbound = issues.filter((i) => /unbound|undefined variable|invalid variable/i.test(i.message));
const unused = issues.filter((i) => /unused/i.test(i.message) && /neverCalled/.test(i.message));
console.log(`unbound variable d: ${unbound.length ? unbound.map((i) => i.code).join(', ') : 'no finding'}`);
console.log(`unused function neverCalled: ${unused.length ? unused.map((i) => i.code).join(', ') : 'no finding'}`);
process.exit(unbound.length > 0 && unused.length > 0 ? 0 : 1);
