/**
 * Checkers on the match document. The host plays dark and moves first.
 *
 * The Security Rules check what one move can change: the mover's turn and
 * piece, that it lands on an empty square (crowned only on the far row), that
 * the from-square empties, that the path and captures have matching lengths,
 * and that only the path's ends and the captured squares change. They can't
 * check jump geometry, mandatory captures, or a win claim; each document keeps
 * the board before the move, and every client replays the move and flags one
 * that isn't legal checkers (`verifyMove`).
 */
import type { GameDefinition, Seat } from '@games/turn-net/types';
import type { MatchDoc } from '@games/turn-net/transitions';
import { applyMove, hasLost, initialPosition, isLegal, isPlayable, squareName, squareOf, type Board, type Move, type Position, type Side } from './checkers.ts';

export const COLLECTION = 'checkers';

/** The 32 playable squares by name to pieces, '' when empty. */
export type BoardMap = Record<string, string>;

export interface StoredMove {
  path: string[];
  captures: string[];
}

export interface CheckersFields {
  board: BoardMap;
  prevBoard: BoardMap;
  lastMove: StoredMove;
}

export type CheckersDoc = MatchDoc & CheckersFields;

export const sideOfSeat = (seat: Seat): Side => (seat === 'host' ? 'd' : 'l');

export function toMap(board: Board): BoardMap {
  const map: BoardMap = {};
  for (let sq = 0; sq < 64; sq++) if (isPlayable(sq)) map[squareName(sq)] = board[sq];
  return map;
}

export function fromMap(map: BoardMap): Board {
  return Array.from({ length: 64 }, (_, sq) => (isPlayable(sq) ? map[squareName(sq)] ?? '' : '') as Board[number]);
}

export function positionOf(board: BoardMap, seat: Seat): Position {
  return { board: fromMap(board), turn: sideOfSeat(seat) };
}

export function initialFields(): CheckersFields {
  const board = toMap(initialPosition().board);
  return { board, prevBoard: board, lastMove: { path: [], captures: [] } };
}

export function moveUpdate(doc: CheckersDoc, move: Move) {
  const seat = doc.currentTurn;
  const next: Seat = seat === 'host' ? 'guest' : 'host';
  const after = applyMove(positionOf(doc.board, seat), move);
  const lost = hasLost(after);
  return {
    board: toMap(after.board),
    prevBoard: doc.board,
    lastMove: { path: move.path.map(squareName), captures: move.captures.map(squareName) },
    currentTurn: next,
    moveCount: doc.moveCount + 1,
    status: lost ? 'won' : 'playing',
    winner: lost ? seat : '',
  } satisfies Partial<CheckersDoc>;
}

/** Whether the last move is legal checkers and produced the stored board and result. */
export function verifyMove(doc: CheckersDoc): boolean {
  if (doc.moveCount === 0) return true;
  const mover: Seat = doc.currentTurn === 'host' ? 'guest' : 'host';
  const move: Move = { path: doc.lastMove.path.map(squareOf), captures: doc.lastMove.captures.map(squareOf) };
  if (!isLegal(positionOf(doc.prevBoard, mover), move)) return false;
  const expected = moveUpdate({ ...doc, board: doc.prevBoard, currentTurn: mover, moveCount: doc.moveCount - 1 }, move);
  if (JSON.stringify(expected.board) !== JSON.stringify(doc.board)) return false;
  if (doc.status === 'resigned') return true;
  return expected.status === doc.status && expected.winner === doc.winner;
}

export const checkers: GameDefinition<CheckersFields, Move> = {
  id: COLLECTION,
  title: 'Checkers',
  logic: {
    initial: initialFields,
    legalMoves: () => [],
    apply: (state) => state,
    outcome: () => ({ status: 'playing' }),
  },
  toFields: (state) => ({ ...state }),
  fromFields: (data) => data as unknown as CheckersFields,
};
