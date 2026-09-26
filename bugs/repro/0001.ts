// Repro 0001: a method called on a let-bound value is rejected by module resolution.
//   bun bugs/repro/0001.ts      (exit 1 while the bug is present)
import { resolveModules } from 'pyric/rules/internal/node';

const source = (body: string) => `rules_version = '2+modules';
import { gameCreate } from './game';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow create: if gameCreate(); }
  }
}`;

const viaLet = `export function gameCreate() {
  let doc = request.resource.data;
  return doc.board.keys().hasOnly(['c0r0']);
}`;
const direct = `export function gameCreate() {
  return request.resource.data.board.keys().hasOnly(['c0r0']);
}`;

const withLet = resolveModules(source(''), { modules: { './game': viaLet } });
const withoutLet = resolveModules(source(''), { modules: { './game': direct } });
console.log('direct receiver:', withoutLet.success ? 'resolves' : withoutLet.error.message);
console.log('let-bound receiver:', withLet.success ? 'resolves' : withLet.error.message);
process.exit(withLet.success ? 0 : 1);
