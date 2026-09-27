/**
 * Air hockey over the Firebase Web SDK: the lobby and the result through
 * Firestore (turn-net), live play through the Realtime Database. Every write
 * is built by logic.ts; the rules decide.
 */
import { getApp } from 'firebase/app';
import { doc, runTransaction, writeBatch } from 'firebase/firestore';
import {
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  set,
  update,
  type Database,
  type Unsubscribe,
} from 'firebase/database';
import { createMatch, joinMatch, type Connection } from '@games/turn-net';
import {
  airHockey,
  finishOps,
  forfeitOps,
  livePath,
  presencePath,
  type AirHockeyDoc,
  type LiveMatch,
  type LiveOp,
  type WriteOp,
} from './logic.ts';
import type { Score, Side } from './physics.ts';

export const createAirHockey = (connection: Connection) => createMatch(connection, airHockey);
export const joinAirHockey = (connection: Connection, id: string) => joinMatch(connection, airHockey, id);

export function liveDatabase(): Database {
  return getDatabase(getApp());
}

export async function applyLive(db: Database, op: LiveOp): Promise<void> {
  if (op.type === 'set') await set(ref(db, op.path), op.value);
  else await update(ref(db, op.path), op.value);
}

async function applyFirestore({ db }: Connection, ops: WriteOp[]): Promise<void> {
  const batch = writeBatch(db);
  for (const op of ops) {
    if (op.type === 'set') batch.set(doc(db, op.path), op.data);
    else batch.update(doc(db, op.path), op.data);
  }
  await batch.commit();
}

/** The host records the result on goals, if the match is still open. */
export async function recordFinish(connection: Connection, id: string, score: Score): Promise<void> {
  const ops = finishOps(id, score);
  await runTransaction(connection.db, async (tx) => {
    const snap = await tx.get(doc(connection.db, ops[0].path));
    if ((snap.data() as AirHockeyDoc | undefined)?.status !== 'playing') return;
    tx.update(doc(connection.db, ops[0].path), ops[0].data);
  });
}

/** `side` records that the other player left. */
export const recordForfeit = (connection: Connection, id: string, side: Side, score: Score) =>
  applyFirestore(connection, forfeitOps(id, side, score));

/**
 * Mark `side` present in the live match, and gone when this client
 * disconnects (the tab closes or the connection drops).
 */
export async function joinPresence(db: Database, id: string, hostUid: string, side: Side): Promise<void> {
  const at = ref(db, presencePath(id, hostUid, side));
  await set(at, true);
  await onDisconnect(at).set(false);
}

/**
 * Watch the live match. A guest can't read it until the host opens it
 * (the rules name the guest in meta), so a denied listener retries.
 */
export function watchLive(db: Database, id: string, hostUid: string, onChange: (live: LiveMatch | null) => void): Unsubscribe {
  let stop: Unsubscribe | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const listen = () => {
    stop = onValue(ref(db, livePath(id, hostUid)), (snap) => onChange((snap.val() as LiveMatch | null) ?? null), () => {
      stop = null;
      if (!stopped) timer = setTimeout(listen, 500);
    });
  };
  listen();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stop?.();
  };
}
