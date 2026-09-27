/**
 * Reversi on the match document. The host plays dark and moves first.
 *
 * The board is a map from square key to disc: the key is the rank then the
 * file as digits ('11' is a1, '45' is e4, '88' is h8), so a step in a
 * direction adds a fixed number (+1 east, +10 north, +11 north-east) and a
 * step off the board lands on a key the map doesn't have. A move stores
 * `lastMove`: the square (`at`) and, for each of the eight directions in
 * reversi.ts order, the reach (`runs`), the number of opponent discs in an
 * unbroken line from the square. The rules check each direction from its
 * reach alone: the discs within it are the opponent's, the square past it is
 * not, and the run flips exactly when that square holds the mover's disc.
 * `counts` keeps each side's discs, so the winner is checked without
 * scanning the board.
 *
 * The rules can't search the board, so they can't tell whether a player who
 * passes had a move, or whether a game marked over has moves left. Each
 * update stores the board before it (`prevBoard`), and every client replays
 * the write and flags one that isn't legal Reversi (`verifyMove`).
 */
import type { GameDefinition, Seat } from '@games/turn-net/types';
import type { MatchDoc } from '@games/turn-net/transitions';
import {
  applyMove,
  counts,
  fileOf,
  initialPosition,
  isLegal,
  next,
  other,
  rankOf,
  squareAt,
  type Board,
  type Cell,
  type Position,
  type Side,
} from './reversi.ts';

export const COLLECTION = 'reversi';

/** Square keys ('11' .. '88') to discs, '' when empty. */
export type BoardMap = Record<string, Cell>;

export interface StoredMove {
  /** The square played, or '' for a pass. */
  at: string;
  /** The reach in each direction, or [] for a pass. */
  runs: number[];
}

export interface ReversiFields {
  board: BoardMap;
  prevBoard: BoardMap;
  lastMove: StoredMove;
  counts: { d: number; l: number };
}

export type ReversiDoc = MatchDoc & ReversiFields;

export type WriteOp =
  | { type: 'set'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> };

export const matchPath = (id: string) => `${COLLECTION}/${id}`;

export const sideOfSeat = (seat: Seat): Side => (seat === 'host' ? 'd' : 'l');
const otherSeat = (seat: Seat): Seat => (seat === 'host' ? 'guest' : 'host');

export function squareKey(sq: number): string {
  return `${rankOf(sq)}${fileOf(sq) + 1}`;
}

export function squareOfKey(key: string): number {
  return squareAt(Number(key[1]) - 1, Number(key[0]));
}

export function toMap(board: Board): BoardMap {
  const map: BoardMap = {};
  for (let sq = 0; sq < 64; sq++) map[squareKey(sq)] = board[sq];
  return map;
}

export function fromMap(map: BoardMap): Board {
  return Array.from({ length: 64 }, (_, sq) => map[squareKey(sq)] ?? '');
}

export function positionOf(board: BoardMap, seat: Seat): Position {
  return { board: fromMap(board), turn: sideOfSeat(seat) };
}

export function initialFields(): ReversiFields {
  const board = toMap(initialPosition().board);
  return { board, prevBoard: board, lastMove: { at: '', runs: [] }, counts: { d: 2, l: 2 } };
}

/** The match fields after the player on turn places a disc on `sq`. */
export function moveUpdate(doc: ReversiDoc, sq: number) {
  const seat = doc.currentTurn;
  const side = sideOfSeat(seat);
  const placed = applyMove(positionOf(doc.board, seat), sq);
  const after = counts(placed.board);
  const over = next(placed.board, other(side)) === 'over';
  const status = !over ? 'playing' : after.d === after.l ? 'draw' : 'won';
  return {
    board: toMap(placed.board),
    prevBoard: doc.board,
    lastMove: { at: squareKey(sq), runs: placed.runs },
    counts: after,
    currentTurn: otherSeat(seat),
    moveCount: doc.moveCount + 1,
    status,
    winner: status === 'won' ? (after.d > after.l ? 'host' : 'guest') : '',
  } satisfies Partial<ReversiDoc>;
}

/** The match fields after the player on turn passes. */
export function passUpdate(doc: ReversiDoc) {
  return {
    prevBoard: doc.board,
    lastMove: { at: '', runs: [] as number[] },
    currentTurn: otherSeat(doc.currentTurn),
    moveCount: doc.moveCount + 1,
  } satisfies Partial<ReversiDoc>;
}

export const moveOps = (id: string, doc: ReversiDoc, sq: number): WriteOp[] =>
  [{ type: 'update', path: matchPath(id), data: moveUpdate(doc, sq) }];

export const passOps = (id: string, doc: ReversiDoc): WriteOp[] =>
  [{ type: 'update', path: matchPath(id), data: passUpdate(doc) }];

/** Whether the player on turn must pass: a match in play where their side has no move. */
export function mustPass(doc: ReversiDoc): boolean {
  return doc.status === 'playing' && next(fromMap(doc.board), sideOfSeat(doc.currentTurn)) !== 'move';
}

/**
 * Whether the last write is legal Reversi: a move legal from the stored
 * previous board that produced the stored board, counts and result, or a
 * pass by a player with no move.
 */
export function verifyMove(doc: ReversiDoc): boolean {
  if (doc.moveCount === 0) return true;
  const mover = otherSeat(doc.currentTurn);
  const sameBoard = (a: BoardMap, b: BoardMap) =>
    Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
  if (doc.lastMove.at === '') {
    return sameBoard(doc.board, doc.prevBoard) && next(fromMap(doc.prevBoard), sideOfSeat(mover)) === 'pass';
  }
  const sq = squareOfKey(doc.lastMove.at);
  if (sq < 0 || !isLegal(positionOf(doc.prevBoard, mover), sq)) return false;
  const expected = moveUpdate({ ...doc, board: doc.prevBoard, currentTurn: mover, moveCount: doc.moveCount - 1 }, sq);
  if (!sameBoard(expected.board, doc.board)
    || expected.lastMove.runs.join() !== (doc.lastMove.runs ?? []).join()
    || expected.counts.d !== doc.counts.d || expected.counts.l !== doc.counts.l) return false;
  if (doc.status === 'resigned') return true;
  return expected.status === doc.status && expected.winner === doc.winner;
}

export const reversi: GameDefinition<ReversiFields, number> = {
  id: COLLECTION,
  title: 'Reversi',
  logic: {
    initial: initialFields,
    legalMoves: () => [],
    apply: (state) => state,
    outcome: () => ({ status: 'playing' }),
  },
  toFields: (state) => ({ ...state }),
  fromFields: (data) => data as unknown as ReversiFields,
};
