/**
 * Chess on the match document. The host plays white.
 *
 * The Security Rules check what one move can change without searching the
 * board: the mover's turn, that the moving piece is theirs, that it arrives on
 * the target square (or promotes there), that the from-square empties, that no
 * king is captured, and that only the squares a move touches change. They
 * can't check piece geometry, check, or a checkmate claim; each document keeps
 * the position before the move, and every client replays the move with the
 * chess rules and flags one that doesn't hold (`verifyMove`).
 */
import type { GameDefinition, Seat } from '@games/turn-net/types';
import type { MatchDoc } from '@games/turn-net/transitions';
import {
  applyMove,
  initialPosition,
  isLegal,
  outcome,
  squareName,
  squareOf,
  type Board,
  type Color,
  type Move,
  type Position,
} from './chess.ts';

export const COLLECTION = 'chess';

/** Squares by name ('a8' .. 'h1') to piece codes, '' when empty. */
export type BoardMap = Record<string, string>;

export interface StoredMove {
  from: string;
  to: string;
  /** '' or the promotion kind. */
  promotion: string;
  /** Other squares the move changes: the rook for castling, the captured pawn for en passant. */
  extra: string[];
}

export interface ChessFields {
  board: BoardMap;
  castling: string;
  enPassant: string;
  prevBoard: BoardMap;
  prevCastling: string;
  prevEnPassant: string;
  lastMove: StoredMove;
}

export type ChessDoc = MatchDoc & ChessFields;

export const colorOf = (seat: Seat): Color => (seat === 'host' ? 'w' : 'b');

export function toMap(board: Board): BoardMap {
  return Object.fromEntries(board.map((p, sq) => [squareName(sq), p]));
}

export function fromMap(map: BoardMap): Board {
  return Array.from({ length: 64 }, (_, sq) => (map[squareName(sq)] ?? '') as Board[number]);
}

export function positionOf(doc: Pick<ChessDoc, 'board' | 'castling' | 'enPassant' | 'currentTurn'>): Position {
  return {
    board: fromMap(doc.board),
    turn: colorOf(doc.currentTurn),
    castling: doc.castling,
    enPassant: doc.enPassant === '' ? -1 : squareOf(doc.enPassant),
  };
}

export function initialFields(): ChessFields {
  const board = toMap(initialPosition().board);
  return {
    board,
    castling: 'KQkq',
    enPassant: '',
    prevBoard: board,
    prevCastling: 'KQkq',
    prevEnPassant: '',
    lastMove: { from: '', to: '', promotion: '', extra: [] },
  };
}

/** The update for `move` from the stored position. */
export function moveUpdate(doc: ChessDoc, move: Move) {
  const before = positionOf(doc);
  const after = applyMove(before, move);
  const board = toMap(after.board);
  const changed = Object.keys(board).filter((sq) => board[sq] !== doc.board[sq]);
  const from = squareName(move.from);
  const to = squareName(move.to);
  const result = outcome(after);
  const seat = doc.currentTurn;
  return {
    board,
    castling: after.castling,
    enPassant: after.enPassant < 0 ? '' : squareName(after.enPassant),
    prevBoard: doc.board,
    prevCastling: doc.castling,
    prevEnPassant: doc.enPassant,
    lastMove: { from, to, promotion: move.promotion ?? '', extra: changed.filter((sq) => sq !== from && sq !== to).sort() },
    currentTurn: (seat === 'host' ? 'guest' : 'host') as Seat,
    moveCount: doc.moveCount + 1,
    status: result === 'checkmate' ? 'won' : result === 'stalemate' ? 'draw' : 'playing',
    winner: result === 'checkmate' ? seat : '',
  } satisfies Partial<ChessDoc>;
}

/**
 * Whether the last move is a legal chess move that produced the stored board,
 * rights, en passant square and result. The rules can't check this.
 */
export function verifyMove(doc: ChessDoc): boolean {
  if (doc.moveCount === 0) return true;
  const mover: Seat = doc.currentTurn === 'host' ? 'guest' : 'host';
  const prev = positionOf({ board: doc.prevBoard, castling: doc.prevCastling, enPassant: doc.prevEnPassant, currentTurn: mover });
  const move: Move = {
    from: squareOf(doc.lastMove.from),
    to: squareOf(doc.lastMove.to),
    ...(doc.lastMove.promotion ? { promotion: doc.lastMove.promotion as Move['promotion'] } : {}),
  };
  if (!isLegal(prev, move)) return false;
  const expected = moveUpdate({ ...doc, board: doc.prevBoard, castling: doc.prevCastling, enPassant: doc.prevEnPassant, currentTurn: mover, moveCount: doc.moveCount - 1 }, move);
  if (JSON.stringify(expected.board) !== JSON.stringify(doc.board)) return false;
  if (expected.castling !== doc.castling || expected.enPassant !== doc.enPassant) return false;
  if (doc.status === 'resigned') return true;
  return expected.status === doc.status && expected.winner === doc.winner;
}

/** Lobby definition for the shared turn-net create and join. */
export const chess: GameDefinition<ChessFields, Move> = {
  id: COLLECTION,
  title: 'Chess',
  logic: {
    initial: initialFields,
    legalMoves: () => [],
    apply: (state) => state,
    outcome: () => ({ status: 'playing' }),
  },
  toFields: (state) => ({ ...state }),
  fromFields: (data) => data as unknown as ChessFields,
};
