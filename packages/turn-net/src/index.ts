/**
 * Firebase client for two-player turn games: sign-in, the lobby, and match
 * moves. Written against the Firebase Web SDK; during `vite dev` the Pyric
 * plugin resolves these imports to the local sandbox.
 */
import { initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import { createdMatch, joinedMatch, movedMatch, resignedMatch, seatOf, type MatchDoc } from './transitions.ts';
import type { GameDefinition, Seat } from './types.ts';

export * from './types.ts';
export * from './transitions.ts';
export * from './rematch.ts';

export interface Connection {
  db: Firestore;
  auth: Auth;
}

export interface ConnectOptions {
  /** A named Firestore database; the project's default database when absent. */
  database?: string;
  /** An Identity Platform tenant that signs this app's players in. */
  tenantId?: string;
}

export function connect(options: FirebaseOptions, { database, tenantId }: ConnectOptions = {}): Connection {
  const app = initializeApp(options);
  const auth = getAuth(app);
  if (tenantId) auth.tenantId = tenantId;
  return { db: database ? getFirestore(app, database) : getFirestore(app), auth };
}

/**
 * Sign this browser in. Local persistence keeps the same anonymous player
 * across reloads and tabs, so every tab of one browser is one player; playing
 * both seats of a match takes two browser profiles or a private window.
 */
export async function signIn(auth: Auth): Promise<User> {
  await setPersistence(auth, browserLocalPersistence);
  const existing = await new Promise<User | null>((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });
  return existing ?? (await signInAnonymously(auth)).user;
}

export interface OpenMatch {
  id: string;
  host: string;
  createdAt: number;
  data: Record<string, unknown>;
}

/** Matches with an open seat in `collectionId`, newest first. */
export function watchOpenMatches(
  { db }: Connection,
  collectionId: string,
  onChange: (matches: OpenMatch[]) => void,
): Unsubscribe {
  const open = query(collection(db, collectionId), where('status', '==', 'waiting'));
  return onSnapshot(open, (snap) => {
    const matches = snap.docs.map((d) => ({
      id: d.id,
      host: d.data().host as string,
      createdAt: d.data().createdAt?.toMillis?.() ?? 0,
      data: d.data(),
    }));
    onChange(matches.sort((a, b) => b.createdAt - a.createdAt));
  });
}

export async function createMatch<S, M>({ db, auth }: Connection, def: GameDefinition<S, M>): Promise<string> {
  const uid = requireUid(auth);
  const ref = await addDoc(collection(db, def.id), { ...createdMatch(def, uid), createdAt: serverTimestamp() });
  return ref.id;
}

export async function cancelMatch<S, M>({ db }: Connection, def: GameDefinition<S, M>, id: string): Promise<void> {
  await deleteDoc(doc(db, def.id, id));
}

export async function joinMatch<S, M>({ db, auth }: Connection, def: GameDefinition<S, M>, id: string): Promise<void> {
  const uid = requireUid(auth);
  const ref = doc(db, def.id, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That match no longer exists.');
    const before = snap.data() as MatchDoc;
    if (before.status !== 'waiting') throw new Error('That match already has two players.');
    const after = joinedMatch(before, uid);
    tx.update(ref, { guest: after.guest, status: after.status });
  });
}

export interface MatchView<S> {
  id: string;
  doc: MatchDoc;
  state: S;
  /** The seat this tab plays, or null when watching someone else's match. */
  seat: Seat | null;
}

export function watchMatch<S, M>(
  { db, auth }: Connection,
  def: GameDefinition<S, M>,
  id: string,
  onChange: (view: MatchView<S> | null) => void,
): Unsubscribe {
  return onSnapshot(doc(db, def.id, id), (snap) => {
    if (!snap.exists()) return onChange(null);
    const data = snap.data() as MatchDoc;
    onChange({ id, doc: data, state: def.fromFields(data), seat: seatOf(data, auth.currentUser?.uid ?? '') });
  });
}

/**
 * Propose the next document for `move`. The transaction reads the current
 * match, so the proposal is built from the latest state; the Security Rules
 * decide whether it is stored.
 */
export async function playMove<S, M>({ db }: Connection, def: GameDefinition<S, M>, id: string, move: M): Promise<void> {
  const ref = doc(db, def.id, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That match no longer exists.');
    const next = movedMatch(def, snap.data() as MatchDoc, move);
    tx.update(ref, next);
  });
}

export async function resign<S, M>({ db }: Connection, def: GameDefinition<S, M>, id: string, seat: Seat): Promise<void> {
  const ref = doc(db, def.id, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That match no longer exists.');
    const after = resignedMatch(snap.data() as MatchDoc, seat);
    tx.update(ref, { status: after.status, winner: after.winner });
  });
}

function requireUid(auth: Auth): string {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in before starting a match.');
  return uid;
}
