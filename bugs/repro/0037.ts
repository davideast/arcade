// Repro 0037: module resolution rejects valid Firestore expressions on values
// derived from request data: membership in a set built from the request
// ("unsupported binding '<derived ambient value>'"), and a method on an
// element of a list built from the request ("unsupported
// binding '<derived ambient receiver>'"). Production evaluates each of these.
// Exit 1 while any case is rejected.
//   bun bugs/repro/0037.ts
import { resolveModules } from 'pyric/rules/internal/node';

const source = `rules_version = '2+modules';
import { check } from './m';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow update: if check(); }
  }
}`;
const cases: Record<string, string> = {
  "'k' in ['k'].toSet() (control)": "export function check() { return 'k' in ['k'].toSet(); }",
  'element in a.diff(b).affectedKeys()':
    "export function check() { return 'k' in request.resource.data.board.diff(resource.data.board).affectedKeys(); }",
  "method on an element of a split: s.split('_')[0].split('-')":
    "export function check() { return request.resource.data.at.split('_')[0].split('-').size() == 1; }",
  "method on an element of a literal split by a request value: 'a_b c'.split(at)[1].split(' ')":
    "export function check() { return 'a_b c'.split(request.resource.data.at)[1].split(' ').size() == 2; }",
  'request.resource.data.list.concat([1]).size() (control)':
    'export function check() { return request.resource.data.list.concat([1]).size() == 2; }',
};
let failed = false;
for (const [name, body] of Object.entries(cases)) {
  const r = resolveModules(source, { modules: { './m': body } });
  console.log(`${name}: ${r.success ? 'resolves' : r.error.message}`);
  failed ||= !r.success;
}
process.exit(failed ? 1 : 0);
