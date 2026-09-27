// Repro 0034: production rejects a ruleset at compile time when a call stack
// holds 22 functions, a function has 12 let bindings, or an expression nests
// 98 levels deep. Pyric's Firestore simulator and Storage evaluator accept all
// of them and allow the request, and the Storage evaluator denies a 21-function
// chain that production compiles.
//   bun bugs/repro/0034.ts      (exit 1 while the bug is present)
import { firestoreRules } from 'pyric/rules';

const chain = (n: number) => {
  const fns = Array.from({ length: n }, (_, i) => `function f${i + 1}() { return ${i + 1 < n ? `f${i + 2}()` : 'true'}; }`).join('\n    ');
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${fns}
    match /docs/{id} { allow read: if f1(); }
  }
}`;
};

const lets = Array.from({ length: 12 }, (_, i) => `let v${i} = ${i};`).join(' ');
const twelveLets = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function f() { ${lets} return v0 == 0; }
    match /docs/{id} { allow read: if f(); }
  }
}`;

const nested = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} { allow read: if ${'('.repeat(98)}true${')'.repeat(98)}; }
  }
}`;

const read = { description: 'read', expectation: 'DENY', method: 'get', path: 'docs/d1', auth: { uid: 'u' } } as const;
const decide = (source: string) => {
  try {
    return firestoreRules(source).simulate([read]).cases[0].decision;
  } catch (e) {
    return `rejected: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
  }
};

const results = {
  'call stack of 22 functions': decide(chain(22)),
  'function with 12 let bindings': decide(twelveLets),
  'expression nested 98 levels': decide(nested),
};
for (const [name, r] of Object.entries(results)) console.log(`${name}: simulate ${r}; production rejects the ruleset at compile time`);
process.exit(Object.values(results).every((r) => r !== 'ALLOW') ? 0 : 1);
