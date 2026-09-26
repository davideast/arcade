// Repro 0004: an update written with a dotted field path must evaluate the same as
// the equivalent whole-map update; production builds the same request.resource.data
// for both. Exit 1 when they disagree.
//   bun bugs/repro/0004.ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin/firestore';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} {
      allow read: if true;
      allow update: if request.auth.uid == resource.data.host
        && resource.data.board[request.resource.data.lastMove] == ''
        && request.resource.data.board[request.resource.data.lastMove] == 'host'
        && request.resource.data.board.diff(resource.data.board).affectedKeys().hasOnly([request.resource.data.lastMove])
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['board', 'lastMove']);
    }
  }
}`;

const sandbox = initializeSandbox();
getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(RULES);
const host = getFirestore(sandbox.withAuth({ uid: 'host-uid' }));
const initial = { host: 'host-uid', lastMove: '', board: { c0r0: '', c1r1: '' } };

async function attempt(id: string, label: string, patch: Record<string, unknown>): Promise<boolean> {
  sandbox.admin.setDocument(`games/${id}`, initial);
  try {
    await host.collection('games').doc(id).update(patch);
    console.log(`${label}: allowed ->`, JSON.stringify(sandbox.admin.getDocument(`games/${id}`)));
    return true;
  } catch (e) {
    console.log(`${label}: ${(e as { code?: string }).code ?? (e as Error).message}`);
    return false;
  }
}

const wholeMap = await attempt('g1', 'whole-map update', { board: { c0r0: '', c1r1: 'host' }, lastMove: 'c1r1' });
const dotted = await attempt('g2', "dotted update 'board.c1r1'", { 'board.c1r1': 'host', lastMove: 'c1r1' });
process.exit(wholeMap === dotted ? 0 : 1);
