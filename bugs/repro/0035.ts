// Repro 0035: in the Firestore rules simulator, `x in <set>` is false for an
// element the set holds. Production (Rules Test API) allows all four rules
// below; the simulator denies the three that test membership in a set.
//   bun bugs/repro/0035.ts      (exit 1 while the bug is present)
import { firestoreRules } from 'pyric/rules';

const conditions: Record<string, string> = {
  "'k' in ['k'].toSet()": "'k' in ['k'].toSet()",
  "'k' in board.diff(before).affectedKeys()": "'k' in request.resource.data.board.diff(resource.data.board).affectedKeys()",
  "'u' in board.diff(before).unchangedKeys()": "'u' in request.resource.data.board.diff(resource.data.board).unchangedKeys()",
  "'k' in board.keys() (a list, control)": "'k' in request.resource.data.board.keys()",
};
const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${Object.values(conditions).map((c, i) => `    match /c${i}/{id} { allow update: if ${c}; }`).join('\n')}
  }
}`;
const summary = firestoreRules(rules).simulate(Object.keys(conditions).map((name, i) => ({
  description: name, expectation: 'ALLOW' as const, method: 'update' as const, path: `c${i}/1`, auth: { uid: 'u' },
  resource: { board: { k: 1, u: 0 } } as never, data: { board: { k: 2, u: 0 } } as never,
})));
let failed = false;
Object.keys(conditions).forEach((name, i) => {
  const decision = summary.cases[i].decision;
  console.log(`${name}: simulate ${decision}; production ALLOW`);
  failed ||= decision !== 'ALLOW';
});
process.exit(failed ? 1 : 0);
