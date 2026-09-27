/**
 * Reversi over the Firebase Web SDK. A move or a pass reads the match in a
 * transaction, builds its write list with logic.ts from that read, and
 * applies it; the rules decide.
 */
import { doc, runTransaction } from 'firebase/firestore';
import { createMatch, joinMatch, type Connection } from '@games/turn-net';
import { matchPath, moveOps, passOps, reversi, type ReversiDoc, type WriteOp } from './logic.ts';

export const createReversi = (connection: Connection) => createMatch(connection, reversi);
export const joinReversi = (connection: Connection, id: string) => joinMatch(connection, reversi, id);

async function act({ db }: Connection, id: string, build: (m: ReversiDoc) => WriteOp[]): Promise<void> {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, matchPath(id)));
    if (!snap.exists()) throw new Error('That match no longer exists.');
    for (const op of build(snap.data() as ReversiDoc)) {
      if (op.type === 'set') tx.set(doc(db, op.path), op.data);
      else tx.update(doc(db, op.path), op.data);
    }
  });
}

/** Place a disc on `sq` from the latest stored board. */
export const moveReversi = (connection: Connection, id: string, sq: number) => act(connection, id, (m) => moveOps(id, m, sq));

/** Pass the turn: the player on turn has no move. */
export const passReversi = (connection: Connection, id: string) => act(connection, id, (m) => passOps(id, m));
