/**
 * Uno over the Firebase Web SDK: the write lists from logic.ts applied in
 * batches, the public match, and this player's private hand (the cards they
 * drew and haven't played, each read from its own deck document).
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { listenOptions, type Connection } from '@games/turn-net';
import { shuffledDeck, type Card } from './cards.ts';
import {
  COLLECTION,
  createdMatch,
  dealOps,
  deckOps,
  drawOps,
  joinOps,
  playOps,
  startOps,
  type UnoMatch,
  type WriteOp,
} from './logic.ts';

export async function applyOps(db: Firestore, ops: WriteOp[]): Promise<void> {
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
  if (!id) throw new Error('Sign in first.');
  return id;
}

async function readMatch(connection: Connection, id: string): Promise<UnoMatch> {
  const snap = await getDoc(doc(connection.db, COLLECTION, id));
  if (!snap.exists()) throw new Error('That table no longer exists.');
  return snap.data() as UnoMatch;
}

export async function createUno(connection: Connection): Promise<string> {
  const ref = await addDoc(collection(connection.db, COLLECTION), { ...createdMatch(uid(connection)), createdAt: serverTimestamp() });
  return ref.id;
}

export async function joinUno(connection: Connection, id: string): Promise<void> {
  const m = await readMatch(connection, id);
  if (m.players.includes(uid(connection))) return;
  await applyOps(connection.db, joinOps(id, m, uid(connection)));
}

/** The host closes a table nobody has started. */
export async function cancelUno(connection: Connection, id: string): Promise<void> {
  await deleteDoc(doc(connection.db, COLLECTION, id));
}

/** The host starts the table: lock the seats, write the shuffled deck, deal. */
export async function startUno(connection: Connection, id: string): Promise<void> {
  const m = await readMatch(connection, id);
  if (m.status === 'waiting') await applyOps(connection.db, startOps(id, m));
  const deck = shuffledDeck(Math.random, m.players.length);
  await applyOps(connection.db, deckOps(id, deck));
  await applyOps(connection.db, dealOps(id, { ...m, status: 'dealing' }, deck));
}

export async function playUno(connection: Connection, id: string, index: number, card: Card, chosen?: string): Promise<void> {
  const m = await readMatch(connection, id);
  await applyOps(connection.db, playOps(id, m, index, card, chosen));
}

export async function drawUno(connection: Connection, id: string): Promise<void> {
  const m = await readMatch(connection, id);
  await applyOps(connection.db, drawOps(id, m));
}

export interface UnoView {
  match: UnoMatch;
  /** This player's cards: deck index and face, in draw order. */
  hand: Array<{ index: number; card: Card }>;
  /** The face of the top card, when known. */
  top: Card | null;
}

/** Watch the table and this player's hand. */
export function watchUno(connection: Connection, id: string, onChange: (view: UnoView | null) => void): () => void {
  const me = uid(connection);
  const faces = new Map<number, Card>();
  let match: UnoMatch | null = null;
  let drawn: number[] = [];
  let played = new Set<number>();
  let version = 0;

  const face = async (index: number): Promise<Card | null> => {
    if (faces.has(index)) return faces.get(index)!;
    const snap = await getDoc(doc(connection.db, COLLECTION, id, 'deck', String(index)));
    if (!snap.exists()) return null;
    const card = (snap.data() as { card: Card }).card;
    faces.set(index, card);
    return card;
  };

  const emit = async () => {
    const mine = ++version;
    if (!match) return onChange(null);
    const holding = drawn.filter((i) => !played.has(i)).sort((a, b) => a - b);
    const hand: Array<{ index: number; card: Card }> = [];
    for (const index of holding) {
      const card = await face(index);
      if (card) hand.push({ index, card });
    }
    const top = match.lastCard >= 0 ? await face(match.lastCard).catch(() => null) : null;
    if (mine === version) onChange({ match, hand, top });
  };

  const stops = [
    onSnapshot(doc(connection.db, COLLECTION, id), listenOptions(), (snap) => {
      match = snap.exists() ? (snap.data() as UnoMatch) : null;
      void emit();
    }),
    onSnapshot(query(collection(connection.db, COLLECTION, id, 'draws'), where('uid', '==', me)), listenOptions(), (snap) => {
      drawn = snap.docs.map((d) => Number(d.id));
      void emit();
    }),
    onSnapshot(collection(connection.db, COLLECTION, id, 'played'), listenOptions(), (snap) => {
      played = new Set(snap.docs.map((d) => Number(d.id)));
      void emit();
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
