import { doc, runTransaction } from 'firebase/firestore';
import { createMatch, joinMatch, type Connection } from '@games/turn-net';
import { COLLECTION, pool, takeShot, type PoolDoc } from './logic.ts';
import type { Shot } from './physics.ts';

export const createPool = (connection: Connection) => createMatch(connection, pool);
export const joinPool = (connection: Connection, id: string) => joinMatch(connection, pool, id);

/**
 * Play `shot` from the latest stored table. The transaction reads the match so
 * the result is computed from the table every client will replay it from.
 */
export async function shootPool({ db }: Connection, id: string, shot: Shot): Promise<void> {
  const ref = doc(db, COLLECTION, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That match no longer exists.');
    tx.update(ref, { ...takeShot(snap.data() as PoolDoc, shot).update });
  });
}
