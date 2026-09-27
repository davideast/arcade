import { describe, expect, test } from 'bun:test';
import { mulberry32 } from '@games/harness';
import { createdMatch, joinedMatch } from '@games/turn-net/transitions';
import {
  applyMove,
  counts,
  flipsIn,
  initialPosition,
  legalMoves,
  next,
  reach,
  squareName,
  squareOfName,
  type Board,
} from './reversi.ts';
import {
  fromMap,
  moveUpdate,
  mustPass,
  passUpdate,
  positionOf,
  reversi,
  squareKey,
  squareOfKey,
  toMap,
  verifyMove,
  type ReversiDoc,
} from './logic.ts';

const sq = squareOfName;
const names = (list: number[]) => list.map(squareName).sort();

/** A board from 'a1:d' style entries. */
function boardOf(...entries: string[]): Board {
  const board: Board = Array(64).fill('');
  for (const e of entries) board[sq(e.slice(0, 2))] = e[3] as 'd' | 'l';
  return board;
}

function freshDoc(): ReversiDoc {
  return joinedMatch(createdMatch(reversi, 'host-uid'), 'guest-uid') as ReversiDoc;
}

describe('squares', () => {
  test('names and keys round trip', () => {
    for (let s = 0; s < 64; s++) {
      expect(squareOfName(squareName(s))).toBe(s);
      expect(squareOfKey(squareKey(s))).toBe(s);
    }
    expect(squareKey(sq('a1'))).toBe('11');
    expect(squareKey(sq('e4'))).toBe('45');
    expect(squareKey(sq('h8'))).toBe('88');
  });
});

describe('moves', () => {
  test('dark opens with four moves', () => {
    const start = initialPosition();
    expect(names(legalMoves(start))).toEqual(['c4', 'd3', 'e6', 'f5']);
    expect(counts(start.board)).toEqual({ d: 2, l: 2 });
  });

  test('d3 flips d4 and records the reach in each direction', () => {
    const placed = applyMove(initialPosition(), sq('d3'));
    expect(names(placed.flipped)).toEqual(['d4']);
    expect(placed.board[sq('d4')]).toBe('d');
    expect(placed.board[sq('d3')]).toBe('d');
    // east, north-east, north, north-west, west, south-west, south, south-east
    expect(placed.runs).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
  });

  test('a move flips every bracketed direction and no unbracketed one', () => {
    // d4 played by dark: east run e4 f4 ends in g4 (dark), north run d5 ends in d6 (empty),
    // north-east run e5 ends in f6 (dark).
    const board = boardOf('e4:l', 'f4:l', 'g4:d', 'd5:l', 'e5:l', 'f6:d');
    const pos = { board, turn: 'd' as const };
    expect(flipsIn(board, sq('d4'), 'd', 0)).toBe(2);
    expect(flipsIn(board, sq('d4'), 'd', 1)).toBe(1);
    expect(reach(board, sq('d4'), 'd', 2)).toBe(1);
    expect(flipsIn(board, sq('d4'), 'd', 2)).toBe(0);
    const placed = applyMove(pos, sq('d4'));
    expect(names(placed.flipped)).toEqual(['e4', 'e5', 'f4']);
    expect(placed.runs).toEqual([2, 1, 1, 0, 0, 0, 0, 0]);
    expect(placed.board[sq('d5')]).toBe('l');
  });

  test('runs stop at the edge without wrapping to the next rank', () => {
    // A light run from b1 to h1 with nothing past h1: a1 flips nothing east.
    const board = boardOf('b1:l', 'c1:l', 'd1:l', 'e1:l', 'f1:l', 'g1:l', 'h1:l', 'a2:d');
    expect(reach(board, sq('a1'), 'd', 0)).toBe(7);
    expect(flipsIn(board, sq('a1'), 'd', 0)).toBe(0);
    // East of g1: h1 is light, and past h1 is off the board, not a2.
    expect(reach(boardOf('h1:l', 'a2:d'), sq('g1'), 'd', 0)).toBe(1);
    expect(flipsIn(boardOf('h1:l', 'a2:d'), sq('g1'), 'd', 0)).toBe(0);
  });

  test('pass and game over', () => {
    // Light has no move but dark does: light passes.
    const pass = boardOf('a1:d', 'b1:l');
    expect(next(pass, 'l')).toBe('pass');
    expect(next(pass, 'd')).toBe('move');
    // Only dark discs: nobody moves.
    expect(next(boardOf('a1:d', 'h8:d'), 'l')).toBe('over');
  });
});

describe('match document', () => {
  test('toMap and fromMap round trip', () => {
    const start = initialPosition().board;
    expect(fromMap(toMap(start))).toEqual(start);
    expect(toMap(start)['44']).toBe('l');
    expect(toMap(start)['45']).toBe('d');
  });

  test('random games play to the end, every write verifies, and forgeries do not', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const random = mulberry32(seed);
      let doc = freshDoc();
      for (let ply = 0; ply < 200 && doc.status === 'playing'; ply++) {
        if (mustPass(doc)) {
          doc = { ...doc, ...passUpdate(doc) } as ReversiDoc;
        } else {
          const moves = legalMoves(positionOf(doc.board, doc.currentTurn));
          const pick = moves[Math.floor(random() * moves.length)];
          const after = { ...doc, ...moveUpdate(doc, pick) } as ReversiDoc;
          // A forged pass instead of this move.
          expect(verifyMove({ ...doc, ...passUpdate(doc) } as ReversiDoc)).toBe(false);
          // A false end claim on this move.
          if (after.status === 'playing') {
            const c = after.counts;
            expect(verifyMove({ ...after, status: c.d === c.l ? 'draw' : 'won', winner: c.d === c.l ? '' : c.d > c.l ? 'host' : 'guest' })).toBe(false);
          }
          doc = after;
        }
        expect(verifyMove(doc)).toBe(true);
        const c = counts(fromMap(doc.board));
        expect(doc.counts).toEqual(c);
      }
      expect(doc.status).not.toBe('playing');
      const c = doc.counts;
      expect(doc.winner).toBe(c.d === c.l ? '' : c.d > c.l ? 'host' : 'guest');
    }
  });

  test('verifyMove flags a missed flip and a move that flips nothing', () => {
    const doc = freshDoc();
    const real = { ...doc, ...moveUpdate(doc, sq('d3')) } as ReversiDoc;
    expect(verifyMove(real)).toBe(true);
    expect(verifyMove({ ...real, board: { ...real.board, [squareKey(sq('d4'))]: 'l' } })).toBe(false);
    const nothing = { ...real, board: { ...doc.board, '11': 'd' }, lastMove: { at: '11', runs: [0, 0, 0, 0, 0, 0, 0, 0] } } as ReversiDoc;
    expect(verifyMove(nothing)).toBe(false);
  });

  test('the last move ends the game with the winner by disc count', () => {
    // Dark plays a1 over b1 on a board with nothing else: after it only dark remains.
    const board = toMap(boardOf('b1:l', 'c1:d'));
    const doc = { ...freshDoc(), board, prevBoard: board, counts: { d: 1, l: 1 }, moveCount: 20 } as ReversiDoc;
    const up = moveUpdate(doc, sq('a1'));
    expect(up.status).toBe('won');
    expect(up.winner).toBe('host');
    expect(up.counts).toEqual({ d: 3, l: 0 });
    expect(verifyMove({ ...doc, ...up } as ReversiDoc)).toBe(true);
  });
});
