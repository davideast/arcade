/**
 * Sokoban logic: parsing, steps and pushes, the solved check, undo and
 * restart, the replay verifier, and the solve write lists.
 */
import { describe, expect, test } from 'bun:test';
import { LEVELS } from './levels.ts';
import { Play, parseLevel, replay, step, isSolved } from './sokoban.ts';
import { minPushes, solveMoves } from './solver.ts';
import { SOLUTIONS } from './solutions.ts';
import { improves, levelById, objectPath, rank, solveWrites, verifyEntry, type ScoreDoc } from './logic.ts';

const tiny = parseLevel([
  '#####',
  '#@$.#',
  '#####',
]);

describe('parse', () => {
  test('reads walls, goals, boxes, the player and the floor', () => {
    expect(tiny.width).toBe(5);
    expect(tiny.height).toBe(3);
    expect(tiny.start).toEqual({ player: 6, boxes: [7] });
    expect(tiny.goals).toEqual([8]);
    expect(tiny.walls.filter(Boolean).length).toBe(12);
    expect(tiny.floor.filter(Boolean).length).toBe(3);
  });

  test('a box on a goal and a player on a goal', () => {
    const l = parseLevel(['#####', '#+*$#', '#####']);
    expect(l.goals).toEqual([6, 7]);
    expect(l.start).toEqual({ player: 6, boxes: [7, 8] });
  });

  test('rejects a level without a player, with two players, or with unmatched boxes', () => {
    expect(() => parseLevel(['#$.#'])).toThrow();
    expect(() => parseLevel(['#@@$.#'])).toThrow();
    expect(() => parseLevel(['#@$$.#'])).toThrow();
    expect(() => parseLevel(['#@$.x#'])).toThrow();
  });

  test('every arcade level parses, and its stored minima match a fresh search', () => {
    for (const spec of LEVELS) {
      const level = parseLevel(spec.rows);
      const best = solveMoves(level);
      expect(best, spec.name).not.toBeNull();
      expect(best!.length, `${spec.name} moves`).toBe(spec.minMoves);
      expect(minPushes(level), `${spec.name} pushes`).toBe(spec.minPushes);
      const kept = replay(level, SOLUTIONS[spec.id]);
      expect(kept.ok && kept.moves, `${spec.name} stored solution`).toBe(spec.minMoves);
    }
  }, 60_000);
});

describe('steps', () => {
  test('walk, push, and blocked steps', () => {
    const walk = step(tiny, tiny.start, 'l');
    expect(walk).toBeNull(); // wall
    const push = step(tiny, tiny.start, 'r')!;
    expect(push.pushed).toBe(true);
    expect(push.position).toEqual({ player: 7, boxes: [8] });
    expect(isSolved(tiny, push.position)).toBe(true);
    // A box against a wall doesn't move.
    expect(step(tiny, push.position, 'r')).toBeNull();
  });

  test('two boxes in a row block a push', () => {
    const l = parseLevel(['######', '#@$$.#', '#   .#', '######']);
    expect(step(l, l.start, 'r')).toBeNull();
    expect(step(l, l.start, 'd')!.pushed).toBe(false);
  });

  test('play with undo and restart', () => {
    const level = levelById('2')!;
    const play = new Play(level);
    expect(play.go('u')).toBe(true);
    expect(play.go('u')).toBe(false); // the top wall
    play.restart();
    expect(play.moveCount).toBe(0);
    const solution = solveMoves(level)!;
    for (const c of solution.slice(0, 5)) play.go(c.toLowerCase() as never);
    expect(play.moves).toBe(solution.slice(0, 5));
    expect(play.undo()).toBe(true);
    expect(play.moves).toBe(solution.slice(0, 4));
    play.restart();
    expect(play.moves).toBe('');
    expect(play.position).toEqual(level.start);
    for (const c of solution) expect(play.go(c.toLowerCase() as never)).toBe(true);
    expect(play.solved).toBe(true);
    expect(play.moveCount).toBe(solution.length);
    expect(play.pushCount).toBe([...solution].filter((c) => c !== c.toLowerCase()).length);
    // Solved: no more steps.
    expect(play.go('l')).toBe(false);
    // Undo still works after the solve, to try for fewer moves.
    expect(play.undo()).toBe(true);
    expect(play.solved).toBe(false);
  });
});

describe('replay', () => {
  const level = levelById('1')!;
  const solution = solveMoves(level)!;

  test('the solution replays', () => {
    expect(replay(level, solution)).toMatchObject({ ok: true, moves: 33, pushes: 8 });
  });

  test('flags a list that does not solve, walks into a wall, or has a case wrong', () => {
    expect(replay(level, solution.slice(0, -1)).ok).toBe(false);
    expect(replay(level, 'u' + solution).ok).toBe(false);
    const i = [...solution].findIndex((c) => c !== c.toLowerCase());
    expect(replay(level, solution.slice(0, i) + solution[i].toLowerCase() + solution.slice(i + 1)).ok).toBe(false);
    const j = [...solution].findIndex((c) => c === c.toLowerCase());
    expect(replay(level, solution.slice(0, j) + solution[j].toUpperCase() + solution.slice(j + 1)).ok).toBe(false);
    expect(replay(level, solution + 'l').ok).toBe(false);
    expect(replay(level, solution.replace(/./, 'x')).ok).toBe(false);
    expect(replay(level, '').ok).toBe(false);
  });
});

describe('solves and the leaderboard', () => {
  const level = levelById('1')!;
  const moves = solveMoves(level)!;
  const solve = 'AbCdEfGhIjKlMnOpQrSt';

  test('the write lists name one object from both sides', () => {
    const w = solveWrites('u1', '1', solve, moves);
    expect(w.score.path).toBe('sokoban/1/scores/u1');
    expect(w.score.data).toEqual({ uid: 'u1', level: '1', moves: 33, pushes: 8, solve, object: `sokoban/u1/1/${solve}-33-8.txt` });
    expect(w.upload).toEqual({
      path: `sokoban/u1/1/${solve}-33-8.txt`,
      text: moves,
      contentType: 'text/plain',
      customMetadata: { level: '1', moves: '33', pushes: '8' },
    });
    expect(new TextEncoder().encode(w.upload.text).length).toBe(33);
  });

  test('improves: fewer moves, or as many moves and fewer pushes', () => {
    expect(improves(undefined, { moves: 50, pushes: 9 })).toBe(true);
    expect(improves({ moves: 40, pushes: 9 }, { moves: 39, pushes: 12 })).toBe(true);
    expect(improves({ moves: 40, pushes: 9 }, { moves: 40, pushes: 8 })).toBe(true);
    expect(improves({ moves: 40, pushes: 9 }, { moves: 40, pushes: 9 })).toBe(false);
    expect(improves({ moves: 40, pushes: 9 }, { moves: 41, pushes: 1 })).toBe(false);
  });

  test('rank by moves, pushes, then time', () => {
    const e = (uid: string, moves: number, pushes: number, t: number) =>
      ({ uid, level: '1', moves, pushes, solve, object: '', createdAt: new Date(t) }) as ScoreDoc;
    expect(rank([e('a', 40, 9, 1), e('b', 33, 9, 5), e('c', 33, 8, 9), e('d', 33, 8, 2)]).map((x) => x.uid)).toEqual(['d', 'c', 'b', 'a']);
  });

  test('verifyEntry accepts a real solve and flags every mismatch', () => {
    const w = solveWrites('u1', '1', solve, moves);
    const entry = w.score.data;
    const meta = w.upload.customMetadata;
    expect(verifyEntry(entry, moves, meta)).toEqual({ ok: true });
    expect(verifyEntry(entry, null).ok).toBe(false);
    expect(verifyEntry(entry, 'l'.repeat(33)).ok).toBe(false);
    expect(verifyEntry({ ...entry, moves: 34 }, moves).ok).toBe(false);
    expect(verifyEntry({ ...entry, pushes: 9 }, moves).ok).toBe(false);
    expect(verifyEntry({ ...entry, level: '2' }, moves).ok).toBe(false);
    expect(verifyEntry({ ...entry, level: '99' }, moves).ok).toBe(false);
    expect(verifyEntry({ ...entry, object: objectPath('u2', '1', solve, 33, 8) }, moves).ok).toBe(false);
    expect(verifyEntry(entry, moves, { ...meta, pushes: '7' }).ok).toBe(false);
  });
});
