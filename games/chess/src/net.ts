import { doc, runTransaction } from 'firebase/firestore';
import { createMatch, joinMatch, type Connection } from '@games/turn-net';
import { COLLECTION, chess, moveUpdate, type ChessDoc } from './logic.ts';
import type { Move } from './chess.ts';

export const createChess = (connection: Connection) => createMatch(connection, chess);
export const joinChess = (connection: Connection, id: string) => joinMatch(connection, chess, id);

/** Play `move` from the latest stored position. */
export async function moveChess({ db }: Connection, id: string, move: Move): Promise<void> {
  const ref = doc(db, COLLECTION, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That match no longer exists.');
    tx.update(ref, { ...moveUpdate(snap.data() as ChessDoc, move) });
  });
}
