/**
 * Yacht over the Firebase Web SDK. Each action reads the match in a
 * transaction, builds its write list with logic.ts, and applies it; the rules
 * decide. Two actions run without a press: a player who is not rolling adds
 * their nonce when a roll is committed, and the roller reveals once every
 * nonce is in. The roller's salt stays in this browser (localStorage, keyed by
 * match and commitment) until the reveal.
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { listenOptions, type Connection } from '@games/turn-net';
import type { Category } from './scoring.ts';
import {
  COLLECTION,
  commitmentOf,
  commitOps,
  createdMatch,
  joinOps,
  matchPath,
  missingNonces,
  nonceOps,
  randomHex,
  revealOps,
  scoreOps,
  startOps,
  type WriteOp,
  type YachtMatch,
} from './logic.ts';

function uid(connection: Connection): string {
  const id = connection.auth.currentUser?.uid;
  if (!id) throw new Error('Sign in first.');
  return id;
}

/** Read the match and apply the writes `build` makes from it, in one transaction. */
async function act(connection: Connection, id: string, build: (m: YachtMatch) => WriteOp[]): Promise<void> {
  const { db } = connection;
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, matchPath(id)));
    if (!snap.exists()) throw new Error('That table no longer exists.');
    for (const op of build(snap.data() as YachtMatch)) {
      if (op.type === 'set') tx.set(doc(db, op.path), op.data);
      else tx.update(doc(db, op.path), op.data);
    }
  });
}

export async function createYacht(connection: Connection): Promise<string> {
  const ref = await addDoc(collection(connection.db, COLLECTION), { ...createdMatch(uid(connection)), createdAt: serverTimestamp() });
  return ref.id;
}

export async function joinYacht(connection: Connection, id: string): Promise<void> {
  const me = uid(connection);
  await act(connection, id, (m) => (m.players.includes(me) ? [] : joinOps(id, m, me)));
}

/** The host closes a table nobody has started. */
export async function cancelYacht(connection: Connection, id: string): Promise<void> {
  await deleteDoc(doc(connection.db, matchPath(id)));
}

export async function startYacht(connection: Connection, id: string): Promise<void> {
  await act(connection, id, (m) => startOps(id, m));
}

const saltKey = (id: string, commit: string) => `yacht-salt:${id}:${commit}`;

/** Commit a fresh salt for the next roll, keeping the dice marked in `keep`. */
export async function rollYacht(connection: Connection, id: string, keep: boolean[]): Promise<void> {
  const salt = randomHex(32);
  const commit = commitmentOf(salt);
  localStorage.setItem(saltKey(id, commit), salt);
  await act(connection, id, (m) => commitOps(id, m, commit, keep));
}

export async function scoreYacht(connection: Connection, id: string, category: Category): Promise<void> {
  await act(connection, id, (m) => scoreOps(id, m, category));
}

/**
 * The write this player owes the pending roll, if any: a nonce for their
 * seat, or the reveal when they are the roller and every nonce is in.
 */
export function owed(m: YachtMatch, me: string): 'nonce' | 'reveal' | null {
  if (m.status !== 'playing' || m.commit === '') return null;
  const seat = m.players.indexOf(me);
  if (seat < 0) return null;
  if (seat === m.turn) return missingNonces(m).length === 0 ? 'reveal' : null;
  return m.nonces[String(seat)] === '' ? 'nonce' : null;
}

/** Add this player's nonce, or reveal this player's roll, as the match needs. */
export async function payOwed(connection: Connection, id: string): Promise<void> {
  const me = uid(connection);
  let revealed = '';
  await act(connection, id, (m) => {
    const due = owed(m, me);
    if (due === 'nonce') return nonceOps(id, m, m.players.indexOf(me), randomHex(32));
    if (due === 'reveal') {
      const salt = localStorage.getItem(saltKey(id, m.commit));
      if (!salt) throw new Error('This browser lost the salt for this roll.');
      revealed = m.commit;
      return revealOps(id, m, salt);
    }
    return [];
  });
  // A revealed salt is public now; drop this browser's copy.
  if (revealed) localStorage.removeItem(saltKey(id, revealed));
}

export function watchYacht(connection: Connection, id: string, onChange: (m: YachtMatch | null) => void): Unsubscribe {
  return onSnapshot(doc(connection.db, matchPath(id)), listenOptions(), (snap) => onChange(snap.exists() ? (snap.data() as YachtMatch) : null));
}
