/**
 * American checkers: men move one square diagonally forward, kings in any
 * diagonal direction; a capture jumps an adjacent opponent onto the empty
 * square beyond, captures are mandatory, a capturing piece keeps jumping while
 * it can, and a man reaching the far row is crowned and its move ends. A player
 * with no legal move loses.
 *
 * Squares are 0..63 with row 0 at the top (rank 8), as drawn. Dark ('d') starts
 * on the bottom three rows and moves first; light ('l') starts on the top.
 * Pieces: 'd' or 'l' for men, 'D' or 'L' for kings.
 */

export type Side = 'd' | 'l';
export type Piece = 'd' | 'l' | 'D' | 'L';
export type Board = (Piece | '')[];

export interface Position {
  board: Board;
  turn: Side;
}

/** A move is the squares the piece visits, and the squares it captures on the way. */
export interface Move {
  path: number[];
  captures: number[];
}

export function squareName(sq: number): string {
  return `${'abcdefgh'[sq % 8]}${8 - Math.floor(sq / 8)}`;
}

export function squareOf(name: string): number {
  return (8 - Number(name[1])) * 8 + 'abcdefgh'.indexOf(name[0]);
}

/** Playing squares are the dark ones: a1, c1, ... where row + column is odd. */
export const isPlayable = (sq: number) => (Math.floor(sq / 8) + (sq % 8)) % 2 === 1;

export function initialPosition(): Position {
  const board: Board = Array(64).fill('');
  for (let sq = 0; sq < 64; sq++) {
    if (!isPlayable(sq)) continue;
    const r = Math.floor(sq / 8);
    if (r < 3) board[sq] = 'l';
    if (r > 4) board[sq] = 'd';
  }
  return { board, turn: 'd' };
}

export const sideOf = (p: Piece | ''): Side | '' => (p === '' ? '' : (p.toLowerCase() as Side));
const isKing = (p: Piece | '') => p === 'D' || p === 'L';
const other = (s: Side): Side => (s === 'd' ? 'l' : 'd');

function directions(piece: Piece): number[][] {
  if (isKing(piece)) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  return piece === 'd' ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
}

const lastRow = (side: Side) => (side === 'd' ? 0 : 7);

function jumpsFrom(board: Board, from: number, piece: Piece, path: number[], captures: number[], out: Move[]): void {
  const r = Math.floor(from / 8);
  const c = from % 8;
  let extended = false;
  // A man that reaches the far row is crowned and stops.
  const crowned = !isKing(piece) && path.length > 1 && r === lastRow(sideOf(piece) as Side);
  if (!crowned) {
    for (const [dr, dc] of directions(piece)) {
      const mr = r + dr;
      const mc = c + dc;
      const lr = r + 2 * dr;
      const lc = c + 2 * dc;
      if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
      const mid = mr * 8 + mc;
      const land = lr * 8 + lc;
      if (sideOf(board[mid]) !== other(sideOf(piece) as Side) || captures.includes(mid) || board[land] !== '') continue;
      extended = true;
      const next = board.slice();
      next[land] = piece;
      next[from] = '';
      jumpsFrom(next, land, piece, [...path, land], [...captures, mid], out);
    }
  }
  if (!extended && captures.length > 0) out.push({ path, captures });
}

export function legalMoves(pos: Position): Move[] {
  const jumps: Move[] = [];
  const steps: Move[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const piece = pos.board[sq];
    if (piece === '' || sideOf(piece) !== pos.turn) continue;
    jumpsFrom(pos.board, sq, piece, [sq], [], jumps);
    const r = Math.floor(sq / 8);
    const c = sq % 8;
    for (const [dr, dc] of directions(piece)) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
      if (pos.board[nr * 8 + nc] === '') steps.push({ path: [sq, nr * 8 + nc], captures: [] });
    }
  }
  return jumps.length > 0 ? jumps : steps;
}

export function applyMove(pos: Position, move: Move): Position {
  const board = pos.board.slice();
  const from = move.path[0];
  const to = move.path[move.path.length - 1];
  let piece = board[from] as Piece;
  board[from] = '';
  for (const sq of move.captures) board[sq] = '';
  if (!isKing(piece) && Math.floor(to / 8) === lastRow(pos.turn)) piece = piece.toUpperCase() as Piece;
  board[to] = piece;
  return { board, turn: other(pos.turn) };
}

const sameMove = (a: Move, b: Move) =>
  a.path.length === b.path.length && a.path.every((sq, i) => sq === b.path[i])
  && a.captures.length === b.captures.length && a.captures.every((sq, i) => sq === b.captures[i]);

export function isLegal(pos: Position, move: Move): boolean {
  return legalMoves(pos).some((m) => sameMove(m, move));
}

/** The side to move has lost when it has no legal move. */
export function hasLost(pos: Position): boolean {
  return legalMoves(pos).length === 0;
}
