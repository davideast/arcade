/**
 * Sokoban over the Firebase Web SDK: a solve writes its score to Firestore,
 * then uploads its move list to Cloud Storage; the leaderboard is a Firestore
 * listener, and each entry's move list is downloaded for the replay check.
 * Every write is built by logic.ts; the rules decide.
 */
import { getApp } from 'firebase/app';
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, type Unsubscribe } from 'firebase/firestore';
import { getBytes, getMetadata, getStorage, ref, uploadString, type FirebaseStorage } from 'firebase/storage';
import { listenOptions, type Connection } from '@games/turn-net';
import { COLLECTION, improves, scorePath, scoresPath, solveWrites, type ScoreDoc } from './logic.ts';

export function storage(): FirebaseStorage {
  return getStorage(getApp());
}

export type SolveResult = { saved: true; moves: number; pushes: number } | { saved: false; best: ScoreDoc };

/**
 * Record a solve of `level` with the LURD text `moves`: the score, then the
 * move list. A solve that doesn't beat this player's best is not written.
 */
export async function submitSolve({ db, auth }: Connection, level: string, moves: string): Promise<SolveResult> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in first.');
  const solve = doc(collection(db, COLLECTION)).id;
  const w = solveWrites(uid, level, solve, moves);
  const best = (await getDoc(doc(db, scorePath(level, uid)))).data() as ScoreDoc | undefined;
  if (best && !improves(best, w.score.data)) return { saved: false, best };
  await setDoc(doc(db, w.score.path), { ...w.score.data, createdAt: serverTimestamp() });
  await uploadString(ref(storage(), w.upload.path), w.upload.text, 'raw', {
    contentType: w.upload.contentType,
    customMetadata: w.upload.customMetadata,
  });
  return { saved: true, moves: w.score.data.moves, pushes: w.score.data.pushes };
}

/** The level's leaderboard: the 20 entries with the fewest moves, live. */
export function watchScores({ db }: Connection, level: string, onChange: (entries: ScoreDoc[]) => void): Unsubscribe {
  const q = query(collection(db, scoresPath(level)), orderBy('moves'), limit(20));
  return onSnapshot(q, listenOptions(), (snap) => onChange(snap.docs.map((d) => d.data() as ScoreDoc)));
}

/** An entry's move list and metadata, or null text when the object is missing or unreadable. */
export async function fetchMoves(object: string): Promise<{ text: string | null; metadata?: Record<string, string> }> {
  try {
    const at = ref(storage(), object);
    const [bytes, meta] = await Promise.all([getBytes(at), getMetadata(at)]);
    return { text: new TextDecoder().decode(bytes), metadata: meta.customMetadata as Record<string, string> | undefined };
  } catch {
    return { text: null };
  }
}
