// Repro 0010: lint's SEC-6 (and SEC-3) follow a called function's return
// expression but not its let bindings, so a function that reads
// request.resource.data (or request.auth) through a let is reported as not
// validating it.
//   bun bugs/repro/0010.ts      (exit 1 while the bug is present)
import { lint } from 'pyric/rules';

const rules = (fn: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${fn}
    match /games/{id} { allow create: if valid(); }
  }
}`;

// The same checks, read directly and through a let.
const direct = rules(`function valid() {
      return request.auth != null && request.resource.data.keys().hasOnly(['a']) && request.resource.data.a == 1;
    }`);
const dataThroughLet = rules(`function valid() {
      let d = request.resource.data;
      return request.auth != null && d.keys().hasOnly(['a']) && d.a == 1;
    }`);
const authThroughLet = rules(`function valid() {
      let uid = request.auth.uid;
      return uid != null && request.resource.data.keys().hasOnly(['a']);
    }`);

const codes = (source: string) => lint(source).map((i) => i.code).filter((c) => c === 'SEC-3' || c === 'SEC-6');
const results = { direct: codes(direct), dataThroughLet: codes(dataThroughLet), authThroughLet: codes(authThroughLet) };
for (const [name, found] of Object.entries(results)) console.log(`${name}: ${found.length ? found.join(', ') : 'no SEC-3 or SEC-6'}`);
process.exit(Object.values(results).every((found) => found.length === 0) ? 0 : 1);
