/**
 * Yacht match state and the writes each action makes, for 2 to 4 players.
 * Every action returns a list of write operations; the browser applies them
 * in a transaction and the rules test applies the same list through
 * pyric-admin, so both exercise identical writes.
 *
 * Fair dice by commit-reveal. No single player controls a roll:
 *   1. commit  The roller picks a secret salt (32 uppercase hex characters)
 *              and stores commit = SHA-256(salt) with the dice they keep.
 *   2. nonce   Every other player stores a public nonce (32 uppercase hex
 *              characters) in nonces[seat]. They see only the commitment.
 *   3. reveal  The roller stores the salt. The rules check SHA-256(salt) ==
 *              commit, then derive the roll from
 *                h = SHA-256(salt + nonces['0'] + nonces['1'] + nonces['2'] + nonces['3'])
 *              (absent seats and the roller's own entry are ''): take h as
 *              uppercase hex, drop every C, D, E and F, and map each of the
 *              first five remaining characters v (0-9, A, B: 0..11) to the die
 *              v % 6 + 1. Rejecting C-F keeps every face equally likely.
 *              Kept dice keep their value; the rest take the derived faces.
 *   The roller commits before any nonce exists and can't change the salt
 *   after, and a nonce writer never sees the salt, so neither side can steer
 *   the roll. A roller can refuse to reveal, which stalls the match but
 *   can't reroll it. Fewer than five characters survive the rejection with
 *   probability below 1e-30; the rules then deny the reveal.
 *
 * A turn is up to three rolls, then one unused category scored. The rules
 * check the points from the stored dice, and the game ends when every player
 * has scored all twelve categories.
 *
 * Document yacht/{m}: host, players (uids by seat), status, turn (seat on
 * turn), rolls (reveals this turn), commit ('' when no roll is pending),
 * keep (5 booleans), nonces (seat '0'..'3' to hex or ''), salt (last
 * revealed), dice (5 faces, 0 before the first roll), scores ('s0'..'s3' to a
 * card), totals (by seat), lastAction, lastSeat (the nonce writer's seat),
 * lastCategory, moveCount (categories scored), winner (seat, -1 until the end;
 * on a tie the first seat with the top total, and status 'draw').
 */
import { CATEGORIES, freshCard, points, unused, type Card, type Category, type Dice } from './scoring.ts';
import { sha256Hex } from './sha256.ts';

export const COLLECTION = 'yacht';
export const MAX_PLAYERS = 4;
export const DICE = 5;
export const ROLLS_PER_TURN = 3;

export type YachtStatus = 'waiting' | 'playing' | 'won' | 'draw';
export type YachtAction = 'create' | 'join' | 'start' | 'commit' | 'nonce' | 'reveal' | 'score';

export interface YachtMatch {
  host: string;
  players: string[];
  status: YachtStatus;
  turn: number;
  rolls: number;
  commit: string;
  keep: boolean[];
  nonces: Record<string, string>;
  salt: string;
  dice: Dice;
  scores: Record<string, Card>;
  totals: number[];
  lastAction: YachtAction;
  lastSeat: number;
  lastCategory: string;
  moveCount: number;
  winner: number;
}

export type WriteOp =
  | { type: 'set'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> };

export function matchPath(id: string): string {
  return `${COLLECTION}/${id}`;
}

export const NO_KEEP = [false, false, false, false, false];

export function createdMatch(host: string): YachtMatch {
  return {
    host,
    players: [host],
    status: 'waiting',
    turn: 0,
    rolls: 0,
    commit: '',
    keep: NO_KEEP,
    nonces: {},
    salt: '',
    dice: [0, 0, 0, 0, 0],
    scores: {},
    totals: [],
    lastAction: 'create',
    lastSeat: 0,
    lastCategory: '',
    moveCount: 0,
    winner: -1,
  };
}

export const scoreKey = (seat: number) => `s${seat}`;

export function emptyNonces(players: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: players }, (_, i) => [String(i), '']));
}

/** The seats whose nonce the pending roll still needs. */
export function missingNonces(m: YachtMatch): number[] {
  if (m.commit === '') return [];
  return m.players.map((_, i) => i).filter((i) => i !== m.turn && m.nonces[String(i)] === '');
}

export function totalTurns(m: Pick<YachtMatch, 'players'>): number {
  return CATEGORIES.length * m.players.length;
}

/** The string both sides hash for a roll's faces. */
export function rollInput(salt: string, nonces: Record<string, string>): string {
  return salt + ['0', '1', '2', '3'].map((k) => nonces[k] ?? '').join('');
}

/** Five faces from a revealed salt and the nonces, as the rules derive them. */
export function derivedFaces(salt: string, nonces: Record<string, string>): Dice {
  const accepted = sha256Hex(rollInput(salt, nonces)).replace(/[C-F]/g, '');
  if (accepted.length < DICE) throw new Error('This roll cannot be derived; commit a new salt.');
  return [...accepted.slice(0, DICE)].map((c) => (parseInt(c, 16) % 6) + 1);
}

/** The dice after a reveal: kept dice stay, the others take the derived faces. */
export function rolledDice(m: YachtMatch, salt: string): Dice {
  const faces = derivedFaces(salt, m.nonces);
  return m.dice.map((d, i) => (m.keep[i] ? d : faces[i]));
}

export function commitmentOf(salt: string): string {
  return sha256Hex(salt);
}

export function isHex(value: string, length: number): boolean {
  return new RegExp(`^[0-9A-F]{${length}}$`).test(value);
}

/** Uppercase hex from a random source: crypto in the browser, a seeded PRNG in tests. */
export function randomHex(chars: number, random: () => number = cryptoRandom): string {
  let out = '';
  for (let i = 0; i < chars; i++) out += Math.floor(random() * 16).toString(16).toUpperCase();
  return out;
}

function cryptoRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

// Transitions. Each checks what the client can check, and throws with a
// message for the player; the rules decide.

export function afterJoin(m: YachtMatch, uid: string): YachtMatch {
  if (m.status !== 'waiting' || m.players.includes(uid) || m.players.length >= MAX_PLAYERS) {
    throw new Error('That table is full or already started.');
  }
  return { ...m, players: [...m.players, uid], lastAction: 'join' };
}

export function afterStart(m: YachtMatch): YachtMatch {
  if (m.status !== 'waiting') throw new Error('This game already started.');
  if (m.players.length < 2) throw new Error('Yacht needs at least two players.');
  const n = m.players.length;
  return {
    ...m,
    status: 'playing',
    nonces: emptyNonces(n),
    scores: Object.fromEntries(m.players.map((_, i) => [scoreKey(i), freshCard()])),
    totals: m.players.map(() => 0),
    lastAction: 'start',
  };
}

export function afterCommit(m: YachtMatch, commit: string, keep: boolean[]): YachtMatch {
  if (m.status !== 'playing') throw new Error('The game is not in play.');
  if (m.commit !== '') throw new Error('A roll is already under way.');
  if (m.rolls >= ROLLS_PER_TURN) throw new Error('No rolls left: score a category.');
  if (m.rolls === 0 && keep.some(Boolean)) throw new Error('The first roll takes all five dice.');
  return { ...m, commit, keep: keep.slice(), nonces: emptyNonces(m.players.length), lastAction: 'commit' };
}

export function afterNonce(m: YachtMatch, seat: number, nonce: string): YachtMatch {
  if (m.commit === '') throw new Error('No roll is waiting for a nonce.');
  if (seat === m.turn) throw new Error('The roller does not add a nonce.');
  if (m.nonces[String(seat)] !== '') throw new Error('This seat already added its nonce.');
  return { ...m, nonces: { ...m.nonces, [String(seat)]: nonce }, lastSeat: seat, lastAction: 'nonce' };
}

export function afterReveal(m: YachtMatch, salt: string): YachtMatch {
  if (m.commit === '') throw new Error('No roll to reveal.');
  if (missingNonces(m).length > 0) throw new Error('Waiting for the other players.');
  if (commitmentOf(salt) !== m.commit) throw new Error('That salt does not match the commitment.');
  return { ...m, salt, dice: rolledDice(m, salt), rolls: m.rolls + 1, commit: '', lastAction: 'reveal' };
}

/** The first seat with the top total, and whether another seat ties it. */
export function result(totals: number[]): { winner: number; status: 'won' | 'draw' } {
  const top = Math.max(...totals);
  const winner = totals.indexOf(top);
  return { winner, status: totals.filter((t) => t === top).length > 1 ? 'draw' : 'won' };
}

export function afterScore(m: YachtMatch, category: Category): YachtMatch {
  if (m.status !== 'playing') throw new Error('The game is not in play.');
  if (m.commit !== '' || m.rolls === 0) throw new Error('Roll before scoring.');
  const key = scoreKey(m.turn);
  if (m.scores[key][category] !== -1) throw new Error('That category is already scored.');
  const earned = points(category, m.dice);
  const totals = m.totals.slice();
  totals[m.turn] += earned;
  const moveCount = m.moveCount + 1;
  const last = moveCount === totalTurns(m);
  const end = last ? result(totals) : { winner: -1, status: 'playing' as const };
  return {
    ...m,
    scores: { ...m.scores, [key]: { ...m.scores[key], [category]: earned } },
    totals,
    turn: last ? m.turn : (m.turn + 1) % m.players.length,
    rolls: 0,
    moveCount,
    lastCategory: category,
    lastAction: 'score',
    status: end.status,
    winner: end.winner,
  };
}

const FIELDS: Record<Exclude<YachtAction, 'create'>, (keyof YachtMatch)[]> = {
  join: ['players', 'lastAction'],
  start: ['status', 'nonces', 'scores', 'totals', 'lastAction'],
  commit: ['commit', 'keep', 'nonces', 'lastAction'],
  nonce: ['nonces', 'lastSeat', 'lastAction'],
  reveal: ['salt', 'dice', 'rolls', 'commit', 'lastAction'],
  score: ['scores', 'totals', 'turn', 'rolls', 'moveCount', 'lastCategory', 'lastAction', 'status', 'winner'],
};

/** The update that turns `m` into `next`: the fields its action may write. */
export function updateOps(id: string, next: YachtMatch): WriteOp[] {
  const data: Record<string, unknown> = {};
  for (const key of FIELDS[next.lastAction as Exclude<YachtAction, 'create'>]) data[key] = next[key];
  return [{ type: 'update', path: matchPath(id), data }];
}

export const joinOps = (id: string, m: YachtMatch, uid: string) => updateOps(id, afterJoin(m, uid));
export const startOps = (id: string, m: YachtMatch) => updateOps(id, afterStart(m));
export const commitOps = (id: string, m: YachtMatch, commit: string, keep: boolean[]) => updateOps(id, afterCommit(m, commit, keep));
export const nonceOps = (id: string, m: YachtMatch, seat: number, nonce: string) => updateOps(id, afterNonce(m, seat, nonce));
export const revealOps = (id: string, m: YachtMatch, salt: string) => updateOps(id, afterReveal(m, salt));
export const scoreOps = (id: string, m: YachtMatch, category: Category) => updateOps(id, afterScore(m, category));

/** The category that scores most for the player on turn, first in card order on a tie. */
export function bestCategory(m: YachtMatch): Category {
  const open = unused(m.scores[scoreKey(m.turn)]);
  return open.reduce((best, c) => (points(c, m.dice) > points(best, m.dice) ? c : best), open[0]);
}
