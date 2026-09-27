import { describe, expect, test } from 'bun:test';
import { mulberry32 } from '@games/harness';
import { CATEGORIES, freshCard, points, type Category } from './scoring.ts';
import { sha256Hex } from './sha256.ts';
import {
  afterCommit,
  afterJoin,
  afterNonce,
  afterReveal,
  afterScore,
  afterStart,
  bestCategory,
  commitmentOf,
  createdMatch,
  derivedFaces,
  missingNonces,
  randomHex,
  result,
  rollInput,
  type YachtMatch,
} from './logic.ts';

describe('sha256Hex', () => {
  test('matches the platform digest as uppercase hex', () => {
    const random = mulberry32(7);
    for (const input of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'yacht é dice', randomHex(200, random)]) {
      const expected = new Bun.CryptoHasher('sha256').update(input).digest('hex').toUpperCase();
      expect(sha256Hex(input)).toBe(expected);
    }
  });
});

describe('points', () => {
  const cases: Array<[Category, number[], number]> = [
    ['ones', [1, 1, 2, 4, 1], 3],
    ['sixes', [6, 6, 6, 2, 6], 24],
    ['threes', [1, 2, 4, 5, 6], 0],
    ['fullHouse', [2, 2, 3, 3, 3], 13],
    ['fullHouse', [4, 4, 4, 4, 4], 0],
    ['fullHouse', [2, 2, 3, 3, 4], 0],
    ['fourKind', [3, 3, 3, 3, 5], 12],
    ['fourKind', [5, 3, 3, 3, 3], 12],
    ['fourKind', [2, 2, 2, 2, 2], 8],
    ['fourKind', [2, 2, 2, 5, 5], 0],
    ['littleStraight', [3, 5, 4, 1, 2], 30],
    ['littleStraight', [2, 3, 4, 5, 6], 0],
    ['bigStraight', [6, 5, 4, 3, 2], 30],
    ['bigStraight', [1, 2, 3, 4, 5], 0],
    ['choice', [1, 2, 3, 4, 6], 16],
    ['yacht', [4, 4, 4, 4, 4], 50],
    ['yacht', [4, 4, 4, 4, 3], 0],
  ];
  for (const [category, dice, expected] of cases) {
    test(`${category} ${dice.join('')} scores ${expected}`, () => expect(points(category, dice)).toBe(expected));
  }
});

describe('dice derivation', () => {
  test('rejects C-F and maps 0..B to faces by v % 6 + 1', () => {
    const nonces = { '0': '', '1': 'A'.repeat(32) };
    const salt = '1'.repeat(32);
    const hex = sha256Hex(rollInput(salt, nonces)).replace(/[C-F]/g, '');
    expect(derivedFaces(salt, nonces)).toEqual([...hex.slice(0, 5)].map((c) => (parseInt(c, 16) % 6) + 1));
  });

  test('the hash input is the salt then seats 0 to 3, absent seats empty', () => {
    expect(rollInput('S', { '0': 'a', '1': '', '2': 'c' })).toBe('Sac');
  });

  test('faces are close to uniform over many rolls', () => {
    const random = mulberry32(3);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 2000; i++) {
      for (const f of derivedFaces(randomHex(32, random), { '0': '', '1': randomHex(32, random) })) counts[f - 1]++;
    }
    for (const c of counts) expect(Math.abs(c - 10000 / 6)).toBeLessThan(200);
  });
});

describe('transitions', () => {
  function started(players: number): YachtMatch {
    let m = createdMatch('p0');
    for (let i = 1; i < players; i++) m = afterJoin(m, `p${i}`);
    return afterStart(m);
  }

  function roll(m: YachtMatch, keep: boolean[], random: () => number): YachtMatch {
    const salt = randomHex(32, random);
    m = afterCommit(m, commitmentOf(salt), keep);
    for (const seat of missingNonces(m)) m = afterNonce(m, seat, randomHex(32, random));
    return afterReveal(m, salt);
  }

  test('join, start and the lobby limits', () => {
    const m = createdMatch('p0');
    expect(() => afterStart(m)).toThrow();
    expect(() => afterJoin(m, 'p0')).toThrow();
    const four = started(4);
    expect(four.scores.s3).toEqual(freshCard());
    expect(four.nonces).toEqual({ '0': '', '1': '', '2': '', '3': '' });
    expect(() => afterJoin({ ...four, status: 'waiting' }, 'p4')).toThrow();
  });

  test('a reveal keeps the kept dice and rerolls the rest', () => {
    const random = mulberry32(11);
    let m = roll(started(3), [false, false, false, false, false], random);
    const first = m.dice.slice();
    m = roll(m, [true, false, true, false, false], random);
    expect(m.dice[0]).toBe(first[0]);
    expect(m.dice[2]).toBe(first[2]);
    expect(m.rolls).toBe(2);
  });

  test('a salt that does not match the commitment is refused', () => {
    const random = mulberry32(5);
    let m = afterCommit(started(2), commitmentOf('A'.repeat(32)), [false, false, false, false, false]);
    m = afterNonce(m, 1, randomHex(32, random));
    expect(() => afterReveal(m, 'B'.repeat(32))).toThrow();
  });

  test('three rolls at most, scoring needs a roll, a category once', () => {
    const random = mulberry32(9);
    let m = started(2);
    expect(() => afterScore(m, 'ones')).toThrow();
    expect(() => afterCommit(m, 'X', [true, false, false, false, false])).toThrow();
    for (let i = 0; i < 3; i++) m = roll(m, [false, false, false, false, false], random);
    expect(() => afterCommit(m, 'X', [false, false, false, false, false])).toThrow();
    m = afterScore(m, 'choice');
    expect(m.turn).toBe(1);
    m = roll(m, [false, false, false, false, false], random);
    m = afterScore(m, 'choice');
    m = roll(m, [false, false, false, false, false], random);
    expect(() => afterScore(m, 'choice')).toThrow();
  });

  test('a whole game ends after every category, with totals and a winner', () => {
    for (const players of [2, 3, 4]) {
      const random = mulberry32(players);
      let m = started(players);
      while (m.status === 'playing') {
        m = roll(m, [false, false, false, false, false], random);
        m = afterScore(m, bestCategory(m));
      }
      expect(m.moveCount).toBe(12 * players);
      for (let seat = 0; seat < players; seat++) {
        const card = m.scores[`s${seat}`];
        expect(CATEGORIES.every((c) => card[c] >= 0)).toBe(true);
        expect(CATEGORIES.reduce((a, c) => a + card[c], 0)).toBe(m.totals[seat]);
      }
      expect(m.winner).toBe(result(m.totals).winner);
    }
  });

  test('result: the first top seat, draw on a tie', () => {
    expect(result([10, 30, 20])).toEqual({ winner: 1, status: 'won' });
    expect(result([30, 10, 30])).toEqual({ winner: 0, status: 'draw' });
  });
});
