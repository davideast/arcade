/**
 * Reversi (Othello) on an 8x8 board. Dark ('d') moves first from the standard
 * start: light on d4 and e5, dark on d5 and e4. A move places a disc on an
 * empty square so that it brackets at least one straight run of opponent
 * discs, in any of the eight directions, against another of the mover's
 * discs; every bracketed run flips. A player with no such move passes, and
 * the game ends when neither player can move. The player with more discs
 * wins; equal counts draw.
 *
 * Squares are 0..63 with row 0 at the top (rank 8), as drawn.
 */

export type Side = 'd' | 'l';
export type Cell = Side | '';
export type Board = Cell[];

export interface Position {
  board: Board;
  turn: Side;
}

/**
 * The eight directions as [file step, rank step], in the order of a move's
 * stored runs. The rules step through the same order by key: +1, +11, +10,
 * +9, -1, -11, -10, -9 (east, north-east, north, north-west, west,
 * south-west, south, south-east).
 */
export const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

export const other = (side: Side): Side => (side === 'd' ? 'l' : 'd');

export const fileOf = (sq: number) => sq % 8;
export const rankOf = (sq: number) => 8 - Math.floor(sq / 8);

/** The square at file 0..7 and rank 1..8, or -1 off the board. */
export function squareAt(file: number, rank: number): number {
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return -1;
  return (8 - rank) * 8 + file;
}

/** The square's name for people: 'a1' .. 'h8'. */
export function squareName(sq: number): string {
  return `${'abcdefgh'[fileOf(sq)]}${rankOf(sq)}`;
}

export function squareOfName(name: string): number {
  return squareAt('abcdefgh'.indexOf(name[0]), Number(name[1]));
}

export function initialPosition(): Position {
  const board: Board = Array(64).fill('');
  board[squareOfName('d4')] = 'l';
  board[squareOfName('e5')] = 'l';
  board[squareOfName('d5')] = 'd';
  board[squareOfName('e4')] = 'd';
  return { board, turn: 'd' };
}

/** The number of opponent discs in an unbroken line from `sq` in direction `dir`, 0..7. */
export function reach(board: Board, sq: number, side: Side, dir: number): number {
  const [df, dr] = DIRECTIONS[dir];
  let n = 0;
  for (let at = squareAt(fileOf(sq) + df, rankOf(sq) + dr); at >= 0 && board[at] === other(side); n++) {
    at = squareAt(fileOf(at) + df, rankOf(at) + dr);
  }
  return n;
}

/** The discs a move at `sq` flips in direction `dir`: the reach when a disc of `side` ends it, else 0. */
export function flipsIn(board: Board, sq: number, side: Side, dir: number): number {
  const n = reach(board, sq, side, dir);
  const [df, dr] = DIRECTIONS[dir];
  const end = squareAt(fileOf(sq) + (n + 1) * df, rankOf(sq) + (n + 1) * dr);
  return n > 0 && end >= 0 && board[end] === side ? n : 0;
}

/** The reach in each direction, the record a move stores. */
export function runsOf(board: Board, sq: number, side: Side): number[] {
  return DIRECTIONS.map((_, dir) => reach(board, sq, side, dir));
}

export function isLegal(pos: Position, sq: number): boolean {
  return sq >= 0 && sq < 64 && pos.board[sq] === '' && DIRECTIONS.some((_, dir) => flipsIn(pos.board, sq, pos.turn, dir) > 0);
}

export function legalMoves(pos: Position): number[] {
  const out: number[] = [];
  for (let sq = 0; sq < 64; sq++) if (isLegal(pos, sq)) out.push(sq);
  return out;
}

export interface Placed {
  board: Board;
  /** The reach in each direction, as stored in the match. */
  runs: number[];
  /** The squares that flipped. */
  flipped: number[];
}

export function applyMove(pos: Position, sq: number): Placed {
  const board = pos.board.slice();
  const flipped: number[] = [];
  DIRECTIONS.forEach(([df, dr], dir) => {
    const n = flipsIn(pos.board, sq, pos.turn, dir);
    for (let k = 1; k <= n; k++) flipped.push(squareAt(fileOf(sq) + k * df, rankOf(sq) + k * dr));
  });
  for (const f of flipped) board[f] = pos.turn;
  board[sq] = pos.turn;
  return { board, runs: runsOf(pos.board, sq, pos.turn), flipped };
}

export function counts(board: Board): { d: number; l: number } {
  return { d: board.filter((c) => c === 'd').length, l: board.filter((c) => c === 'l').length };
}

/** What follows a position: the side to move plays, passes, or the game is over. */
export function next(board: Board, toMove: Side): 'move' | 'pass' | 'over' {
  if (legalMoves({ board, turn: toMove }).length > 0) return 'move';
  return legalMoves({ board, turn: other(toMove) }).length > 0 ? 'pass' : 'over';
}
