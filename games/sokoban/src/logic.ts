/**
 * Sokoban's documents and objects, shared by the client and the rules tests.
 *
 * A solve writes two things, in this order:
 *
 * 1. The score document `sokoban/{level}/scores/{uid}`, one per player per
 *    level, holding that player's best: the move and push counts, the solve
 *    id, and the object that holds its moves. A later solve replaces it only
 *    when it takes fewer moves, or as many moves and fewer pushes.
 * 2. The object `sokoban/{uid}/{level}/{solve}-{moves}-{pushes}.txt`: the
 *    move list as LURD text, `text/plain`, with custom metadata naming the
 *    level and both counts. The Storage rules read the score document and
 *    allow the upload only when the score names this object; objects are
 *    never replaced or deleted.
 *
 * Rules can't replay a move list. Every client downloads each leaderboard
 * entry's object, replays it on the level, and flags an entry whose moves
 * don't solve the level or don't match its counts.
 */
import { levelSpec } from './levels.ts';
import { countPushes, parseLevel, replay, type Level } from './sokoban.ts';

export const COLLECTION = 'sokoban';
/** The most moves a score may claim; a move list is one byte per move. */
export const MAX_MOVES = 2000;
export const CONTENT_TYPE = 'text/plain';

export interface ScoreFields {
  uid: string;
  level: string;
  moves: number;
  pushes: number;
  /** The solve's id: 20 letters and digits. */
  solve: string;
  /** The Storage object that holds the moves. */
  object: string;
}

export interface ScoreDoc extends ScoreFields {
  createdAt: { toMillis(): number } | Date | null;
}

export interface Upload {
  path: string;
  text: string;
  contentType: string;
  customMetadata: { level: string; moves: string; pushes: string };
}

export interface SolveWrites {
  /** The score document; the writer adds `createdAt` as the server time. */
  score: { path: string; data: ScoreFields };
  upload: Upload;
}

export const scoresPath = (level: string) => `${COLLECTION}/${level}/scores`;
export const scorePath = (level: string, uid: string) => `${scoresPath(level)}/${uid}`;
export const objectPath = (uid: string, level: string, solve: string, moves: number, pushes: number) =>
  `${COLLECTION}/${uid}/${level}/${solve}-${moves}-${pushes}.txt`;

const levelCache = new Map<string, Level>();

/** The parsed level for an id, or undefined for a level the arcade doesn't have. */
export function levelById(id: string): Level | undefined {
  const spec = levelSpec(id);
  if (!spec) return undefined;
  let level = levelCache.get(id);
  if (!level) {
    level = parseLevel(spec.rows);
    levelCache.set(id, level);
  }
  return level;
}

/** The two writes for a solve of `level` by `uid` with the LURD text `moves`. */
export function solveWrites(uid: string, level: string, solve: string, moves: string): SolveWrites {
  const pushes = countPushes(moves);
  const object = objectPath(uid, level, solve, moves.length, pushes);
  return {
    score: { path: scorePath(level, uid), data: { uid, level, moves: moves.length, pushes, solve, object } },
    upload: {
      path: object,
      text: moves,
      contentType: CONTENT_TYPE,
      customMetadata: { level, moves: String(moves.length), pushes: String(pushes) },
    },
  };
}

/** Whether `next` beats `best`: fewer moves, or as many moves and fewer pushes. */
export function improves(best: { moves: number; pushes: number } | undefined, next: { moves: number; pushes: number }): boolean {
  if (!best) return true;
  return next.moves < best.moves || (next.moves === best.moves && next.pushes < best.pushes);
}

const millis = (t: ScoreDoc['createdAt']) => (t === null ? Infinity : t instanceof Date ? t.getTime() : t.toMillis());

/** Leaderboard order: fewest moves, then fewest pushes, then the earlier solve. */
export function rank<T extends ScoreDoc>(entries: T[]): T[] {
  return entries.slice().sort((a, b) => a.moves - b.moves || a.pushes - b.pushes || millis(a.createdAt) - millis(b.createdAt));
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Check a leaderboard entry against its downloaded move list (`text`, null
 * when the object is missing) and the object's custom metadata. The move
 * list must solve the level, and the entry's counts, its object path, the
 * list's length and the metadata must all agree with the replay.
 */
export function verifyEntry(entry: ScoreFields, text: string | null, metadata?: Record<string, string>): Verdict {
  const level = levelById(entry.level);
  if (!level) return { ok: false, reason: `level ${entry.level} does not exist` };
  if (text === null) return { ok: false, reason: 'no move list' };
  const result = replay(level, text);
  if (!result.ok) return { ok: false, reason: result.reason };
  if (result.moves !== entry.moves) return { ok: false, reason: `claims ${entry.moves} moves, the list has ${result.moves}` };
  if (result.pushes !== entry.pushes) return { ok: false, reason: `claims ${entry.pushes} pushes, the list has ${result.pushes}` };
  if (entry.object !== objectPath(entry.uid, entry.level, entry.solve, entry.moves, entry.pushes)) {
    return { ok: false, reason: 'names an object that is not its own' };
  }
  if (metadata && (metadata.level !== entry.level || metadata.moves !== String(entry.moves) || metadata.pushes !== String(entry.pushes))) {
    return { ok: false, reason: 'object metadata does not match the claim' };
  }
  return { ok: true };
}
