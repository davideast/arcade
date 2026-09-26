/**
 * Uno match state and the writes each action makes. Every action returns a
 * list of write operations; the browser applies them in one Firestore batch
 * and the rules tests apply the same list through pyric-admin, so both
 * exercise identical writes.
 *
 * Documents:
 *   uno/{m}              the public match: seats, turn, direction, top card, counts
 *   uno/{m}/deck/{i}     card i of the host's shuffled deck ({ card })
 *   uno/{m}/draws/{i}    who drew card i ({ uid }); only they may read deck/{i}
 *   uno/{m}/played/{i}   card i was played ({ by }); played cards are public
 */
import { DECK_SIZE, HAND_SIZE, MAX_PLAYERS, canPlay, colorOf, isWild, valueOf, type Card } from './cards.ts';

export type UnoStatus = 'waiting' | 'dealing' | 'playing' | 'won';
export type UnoAction = 'create' | 'join' | 'start' | 'deal' | 'play' | 'draw' | 'pass';

export interface UnoMatch {
  host: string;
  players: string[];
  /** players.length, kept as a field so rules on subcollections can read it. */
  size: number;
  counts: number[];
  status: UnoStatus;
  turn: number;
  direction: 1 | -1;
  /** The color in play: the top card's color, or the color chosen for a wild. */
  color: string;
  /** The top card's value. */
  value: string;
  /** Cards the player on turn must draw before playing (after a draw two or wild draw four). */
  pending: number;
  drawIndex: number;
  lastCard: number;
  lastAction: UnoAction;
  moveCount: number;
  winner: string;
}

export type WriteOp =
  | { type: 'set'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> };

export const COLLECTION = 'uno';

export function matchPath(id: string): string {
  return `${COLLECTION}/${id}`;
}

export function createdMatch(host: string): UnoMatch {
  return {
    host,
    players: [host],
    size: 1,
    counts: [0],
    status: 'waiting',
    turn: 0,
    direction: 1,
    color: '',
    value: '',
    pending: 0,
    drawIndex: 0,
    lastCard: -1,
    lastAction: 'create',
    moveCount: 0,
    winner: '',
  };
}

export function joinOps(id: string, m: UnoMatch, uid: string): WriteOp[] {
  if (m.status !== 'waiting' || m.players.includes(uid) || m.players.length >= MAX_PLAYERS) {
    throw new Error('That table is full or already started.');
  }
  return [{ type: 'update', path: matchPath(id), data: { players: [...m.players, uid], size: m.size + 1, counts: [...m.counts, 0], lastAction: 'join' } }];
}

export function startOps(id: string, m: UnoMatch): WriteOp[] {
  if (m.players.length < 2) throw new Error('Uno needs at least two players.');
  return [{ type: 'update', path: matchPath(id), data: { status: 'dealing', lastAction: 'start' } }];
}

/** The host writes the shuffled deck; card i is readable only by whoever draws it. */
export function deckOps(id: string, deck: Card[]): WriteOp[] {
  return deck.map((card, i) => ({ type: 'set', path: `${matchPath(id)}/deck/${i}`, data: { card } }));
}

/** Deal seven cards to each seat in turn, and turn the next card face up. */
export function dealOps(id: string, m: UnoMatch, deck: Card[]): WriteOp[] {
  const n = m.players.length;
  const top = deck[n * HAND_SIZE];
  const ops: WriteOp[] = [];
  for (let i = 0; i < n * HAND_SIZE; i++) {
    ops.push({ type: 'set', path: `${matchPath(id)}/draws/${i}`, data: { uid: m.players[i % n] } });
  }
  ops.push({ type: 'set', path: `${matchPath(id)}/played/${n * HAND_SIZE}`, data: { by: m.host } });
  ops.push({
    type: 'update',
    path: matchPath(id),
    data: {
      status: 'playing',
      counts: m.players.map(() => HAND_SIZE),
      turn: 0,
      direction: 1,
      color: colorOf(top),
      value: valueOf(top),
      pending: 0,
      drawIndex: n * HAND_SIZE + 1,
      lastCard: n * HAND_SIZE,
      lastAction: 'deal',
    },
  });
  return ops;
}

function seatAfter(m: UnoMatch, direction: 1 | -1, step: number): number {
  const n = m.players.length;
  return (((m.turn + direction * step) % n) + n) % n;
}

/** The match after the player on turn plays deck card `index` (with `chosen` color for wilds). */
export function afterPlay(m: UnoMatch, index: number, card: Card, chosen?: string): UnoMatch {
  if (m.pending > 0) throw new Error('Draw your penalty cards first.');
  if (!canPlay(card, m.color, m.value)) throw new Error('That card does not match.');
  if (isWild(card) && !chosen) throw new Error('Choose a color for the wild.');
  const value = valueOf(card);
  const n = m.players.length;
  const direction = value === 'r' ? (-m.direction as 1 | -1) : m.direction;
  const step = value === 's' || (value === 'r' && n === 2) ? 2 : 1;
  const counts = m.counts.slice();
  counts[m.turn] -= 1;
  const won = counts[m.turn] === 0;
  return {
    ...m,
    counts,
    direction,
    turn: won ? m.turn : seatAfter(m, direction, step),
    color: isWild(card) ? chosen! : colorOf(card),
    value,
    pending: value === 'd' ? 2 : value === '+' ? 4 : 0,
    lastCard: index,
    lastAction: 'play',
    moveCount: m.moveCount + 1,
    status: won ? 'won' : 'playing',
    winner: won ? m.players[m.turn] : '',
  };
}

export function playOps(id: string, m: UnoMatch, index: number, card: Card, chosen?: string): WriteOp[] {
  const next = afterPlay(m, index, card, chosen);
  return [
    { type: 'set', path: `${matchPath(id)}/played/${index}`, data: { by: m.players[m.turn] } },
    { type: 'update', path: matchPath(id), data: matchUpdate(m, next) },
  ];
}

/** The player on turn draws their penalty, or one card; either way the turn passes. */
export function afterDraw(m: UnoMatch): UnoMatch {
  const k = m.pending > 0 ? m.pending : 1;
  const available = Math.min(k, DECK_SIZE - m.drawIndex);
  const counts = m.counts.slice();
  counts[m.turn] += available;
  return {
    ...m,
    counts,
    pending: 0,
    drawIndex: m.drawIndex + available,
    turn: seatAfter(m, m.direction, 1),
    lastAction: available > 0 ? 'draw' : 'pass',
    moveCount: m.moveCount + 1,
  };
}

export function drawOps(id: string, m: UnoMatch): WriteOp[] {
  const next = afterDraw(m);
  const ops: WriteOp[] = [];
  for (let i = m.drawIndex; i < next.drawIndex; i++) {
    ops.push({ type: 'set', path: `${matchPath(id)}/draws/${i}`, data: { uid: m.players[m.turn] } });
  }
  ops.push({ type: 'update', path: matchPath(id), data: matchUpdate(m, next) });
  return ops;
}

/** The fields of `next` that differ from `m`, plus lastAction and moveCount. */
function matchUpdate(m: UnoMatch, next: UnoMatch): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof UnoMatch)[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(m[key]) || key === 'lastAction' || key === 'moveCount') data[key] = next[key];
  }
  return data;
}

/** Which deck indexes a player holds: drawn by them and not yet played. */
export function handIndexes(draws: Map<number, string>, played: Set<number>, uid: string): number[] {
  return [...draws].filter(([i, holder]) => holder === uid && !played.has(i)).map(([i]) => i).sort((a, b) => a - b);
}
