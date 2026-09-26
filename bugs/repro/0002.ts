// Repro 0002: lint metrics are zero for resolved modular rules, whose functions sit at service scope.
//   bun bugs/repro/0002.ts      (exit 1 while the bug is present)
import { lintFirestoreRules } from 'pyric/rules/internal';

const inMatch = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    match /games/{id} { allow read: if signedIn(); }
  }
}`;
// The shape `pyric firestore rules resolve` writes: functions at service scope.
const atServiceScope = `rules_version = '2';
service cloud.firestore {
  function signedIn() { return request.auth != null; }
  match /databases/{database}/documents {
    match /games/{id} { allow read: if signedIn(); }
  }
}`;

const a = lintFirestoreRules(inMatch).metrics;
const b = lintFirestoreRules(atServiceScope).metrics;
console.log('function in match block:  functionCount', a.functionCount, 'maxEstimatedExpressions', a.maxEstimatedExpressions);
console.log('function at service scope: functionCount', b.functionCount, 'maxEstimatedExpressions', b.maxEstimatedExpressions);
process.exit(b.functionCount === 1 ? 0 : 1);
