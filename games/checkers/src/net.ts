import { doc, runTransaction } from 'firebase/firestore';
import { createMatch, joinMatch, type Connection } from '@games/turn-net';
import { COLLECTION, checkers, moveUpdate, type CheckersDoc } from './logic.ts';
import type { Move } from './checkers.ts';

export const createCheckers = (connection: Connection) => createMatch(connection, checkers);
export const joinCheckers = (connection: Connection, id: string) => joinMatch(connection, checkers, id);

/** Play `move` from the latest stored board. */
export async function moveCheckers({ db }: Connection, id: string, move: Move): Promise<void> {
  const ref = doc(db, COLLECTION, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That match no longer exists.');
    tx.update(ref, { ...moveUpdate(snap.data() as CheckersDoc, move) });
  });
}
