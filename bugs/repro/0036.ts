// Repro 0036: the Firestore rules simulator evaluates two list operations that
// production rejects at evaluation. Production (Rules Test API) denies both
// rules below: `list + list` with "Unsupported operation error. Received:
// list + list", and a slice with no elements with "Index out of bound error.
// Index: [-1]". The simulator allows both.
//   bun bugs/repro/0036.ts      (exit 1 while the bug is present)
import { firestoreRules } from 'pyric/rules';

const conditions: Record<string, string> = {
  "(['a'] + ['b']).size() == 2": "(['a'] + ['b']).size() == 2",
  "['a', 'b'][0:0] == []": "['a', 'b'][0:0] == []",
  "['a', 'b'].concat(['c']).size() == 3 (control)": "['a', 'b'].concat(['c']).size() == 3",
  "['a', 'b'][0:1] == ['a'] (control)": "['a', 'b'][0:1] == ['a']",
};
const expected = ['DENY', 'DENY', 'ALLOW', 'ALLOW'];
const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${Object.values(conditions).map((c, i) => `    match /c${i}/{id} { allow get: if ${c}; }`).join('\n')}
  }
}`;
const summary = firestoreRules(rules).simulate(Object.keys(conditions).map((name, i) => ({
  description: name, expectation: 'ALLOW' as const, method: 'get' as const, path: `c${i}/1`, auth: { uid: 'u' },
})));
let failed = false;
Object.keys(conditions).forEach((name, i) => {
  const decision = summary.cases[i].decision;
  console.log(`${name}: simulate ${decision}; production ${expected[i]}`);
  failed ||= decision !== expected[i];
});
process.exit(failed ? 1 : 0);
