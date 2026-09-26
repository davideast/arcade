// Repro 0006: module resolution rejects Firestore's global conversion functions
// (string(), int()) inside a module function. Production supports both. Exit 1 while rejected.
//   bun bugs/repro/0006.ts
import { resolveModules } from 'pyric/rules/internal/node';

const source = `rules_version = '2+modules';
import { check } from './m';
service cloud.firestore {
  match /databases/{database}/documents {
    match /cards/{i} { allow read: if check(i); }
  }
}`;
let failed = false;
for (const [name, body] of [
  ['string()', "export function check(i) { return string(1) == i; }"],
  ['int()', "export function check(i) { return int(i) < 108; }"],
] as const) {
  const r = resolveModules(source, { modules: { './m': body } });
  console.log(`${name} in a module:`, r.success ? 'resolves' : r.error.message);
  failed ||= !r.success;
}
const inMain = resolveModules(source.replace('if check(i)', 'if int(i) < 108 && check(i)'), {
  modules: { './m': 'export function check(i) { return true; }' },
});
console.log('int() in the main file:', inMain.success ? 'resolves' : inMain.error.message);
process.exit(failed ? 1 : 0);
