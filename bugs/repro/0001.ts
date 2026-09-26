// Repro 0001: in a module, a method call on a field of a document the analyzer
// can't type is rejected: a let binding, a get()/getAfter() result, or a parameter
// that receives one. resource.data works. Exit 1 while any case is rejected.
//   bun bugs/repro/0001.ts
import { resolveModules } from 'pyric/rules/internal/node';

const source = `rules_version = '2+modules';
import { check } from './m';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow write: if check(database); }
  }
}`;
const cases: Record<string, string> = {
  'resource.data.players.size() (control)': 'export function check(db) { return resource.data.players.size() > 0; }',
  'let doc = request.resource.data; doc.board.keys()':
    "export function check(db) { let doc = request.resource.data; return doc.board.keys().hasOnly(['c0r0']); }",
  'get(...).data.players.size()': 'export function check(db) { return get(/databases/$(db)/documents/games/g).data.players.size() > 0; }',
  'getAfter(...).data.players.size()': 'export function check(db) { return getAfter(/databases/$(db)/documents/games/g).data.players.size() > 0; }',
  'parameter bound to get(...).data': 'export function check(db) { return count(get(/databases/$(db)/documents/games/g).data); }\nfunction count(m) { return m.players.size() > 0; }',
};
let failed = false;
for (const [name, body] of Object.entries(cases)) {
  const r = resolveModules(source, { modules: { './m': body } });
  console.log(`${name}: ${r.success ? 'resolves' : r.error.message}`);
  failed ||= !r.success;
}
process.exit(failed ? 1 : 0);
