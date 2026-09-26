import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type { Connection, Seat } from '@games/turn-net';
import {
  COLLECTION,
  createdMatch,
  joinOps,
  matchPath,
  readyOps,
  shotOps,
  type BattleshipMatch,
  type BoardDoc,
  type Placement,
  type ShotDoc,
  type WriteOp,
} from './logic.ts';

async function applyOps({ db }: Connection, ops: WriteOp[]): Promise<void> {
  const batch = writeBatch(db);
  for (const op of ops) {
    const ref = doc(db, op.path);
    if (op.type === 'set') batch.set(ref, op.data);
    else batch.update(ref, op.data);
  }
  await batch.commit();
}

function uid(connection: Connection): string {
  const id = connection.auth.currentUser?.uid;
  if (!id) throw new Error('Sign in before playing.');
  return id;
}

export async function createBattleship(connection: Connection): Promise<string> {
  const ref = await addDoc(collection(connection.db, COLLECTION), { ...createdMatch(uid(connection)), createdAt: serverTimestamp() });
  return ref.id;
}

export async function joinBattleship(connection: Connection, id: string): Promise<void> {
  await applyOps(connection, joinOps(id, uid(connection)));
}

export async function cancelBattleship(connection: Connection, id: string): Promise<void> {
  await deleteDoc(doc(connection.db, matchPath(id)));
}

export async function resignBattleship(connection: Connection, id: string, seat: Seat): Promise<void> {
  await updateDoc(doc(connection.db, matchPath(id)), { status: 'resigned', winner: seat === 'host' ? 'guest' : 'host' });
}

export async function readyBattleship(connection: Connection, id: string, m: BattleshipMatch, seat: Seat, fleet: Placement[]): Promise<void> {
  await applyOps(connection, readyOps(id, m, seat, fleet));
}

/**
 * Fire at `cell`. The attacker can't read the defender's fleet, so this
 * proposes a miss and, if the rules refuse it, a hit: the rules check the
 * answer against the fleet, and exactly one of the two is stored.
 */
export async function fireBattleship(connection: Connection, id: string, m: BattleshipMatch, cell: number): Promise<boolean> {
  try {
    await applyOps(connection, shotOps(id, m, cell, false));
    return false;
  } catch (error) {
    if (!/denied|permission/i.test(String(error))) throw error;
  }
  await applyOps(connection, shotOps(id, m, cell, true));
  return true;
}

export interface BattleshipView {
  match: BattleshipMatch | null;
  seat: Seat | null;
  shots: ShotDoc[];
  /** This player's fleet, once placed. */
  mine: BoardDoc | null;
  /** The opponent's fleet, readable only after the match ends. */
  theirs: BoardDoc | null;
}

export function watchBattleship(connection: Connection, id: string, onChange: (view: BattleshipView) => void): Unsubscribe {
  const me = uid(connection);
  const view: BattleshipView = { match: null, seat: null, shots: [], mine: null, theirs: null };
  const emit = () => onChange({ ...view });
  const readBoard = async (owner: string) => {
    try {
      const snap = await getDoc(doc(connection.db, `${matchPath(id)}/boards/${owner}`));
      return snap.exists() ? (snap.data() as BoardDoc) : null;
    } catch {
      return null;
    }
  };
  const stopMatch = onSnapshot(doc(connection.db, matchPath(id)), async (snap) => {
    const m = snap.exists() ? (snap.data() as BattleshipMatch) : null;
    view.match = m;
    view.seat = m ? (m.host === me ? 'host' : m.guest === me ? 'guest' : null) : null;
    if (m && view.seat && !view.mine && m[`${view.seat}Ready`]) view.mine = await readBoard(me);
    if (m && view.seat && !view.theirs && (m.status === 'won' || m.status === 'resigned')) {
      view.theirs = await readBoard(view.seat === 'host' ? m.guest : m.host);
    }
    emit();
  });
  const stopShots = onSnapshot(collection(connection.db, `${matchPath(id)}/shots`), (snap) => {
    view.shots = snap.docs.map((d) => d.data() as ShotDoc);
    emit();
  });
  return () => {
    stopMatch();
    stopShots();
  };
}
