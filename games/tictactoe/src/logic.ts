import type { GameDefinition, GameLogic, Outcome, Seat } from '@games/turn-net/types';

/** Cells in row-major order: index = row * 3 + col. */
export type Cell = '' | Seat;
export type Board = Cell[];
/** A move is the index of the cell to mark. */
export type Move = number;

export const SIZE = 3;

export const LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function cellName(index: number): string {
  return `c${index % SIZE}r${Math.floor(index / SIZE)}`;
}

export const CELL_NAMES = Array.from({ length: SIZE * SIZE }, (_, i) => cellName(i));

export const logic: GameLogic<Board, Move> = {
  initial: () => Array<Cell>(SIZE * SIZE).fill(''),

  legalMoves: (board) => board.flatMap((cell, i) => (cell === '' ? [i] : [])),

  apply(board, move, seat) {
    if (board[move] !== '') throw new Error(`Cell ${cellName(move)} is taken`);
    const next = board.slice();
    next[move] = seat;
    return next;
  },

  outcome(board): Outcome {
    for (const [a, b, c] of LINES) {
      const mark = board[a];
      if (mark !== '' && mark === board[b] && mark === board[c]) return { status: 'won', winner: mark };
    }
    return board.every((cell) => cell !== '') ? { status: 'draw' } : { status: 'playing' };
  },
};

export const ticTacToe: GameDefinition<Board, Move> = {
  id: 'tictactoe',
  title: 'Tic-Tac-Toe',
  logic,
  toFields: (board, move) => ({
    board: Object.fromEntries(board.map((cell, i) => [cellName(i), cell])),
    lastMove: move === null ? '' : cellName(move),
  }),
  fromFields: (data) => {
    const board = data.board as Record<string, Cell>;
    return CELL_NAMES.map((name) => board[name] ?? '');
  },
};
