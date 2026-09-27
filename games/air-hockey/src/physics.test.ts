import { describe, expect, test } from 'bun:test';
import {
  GOAL_LEFT,
  GOAL_RIGHT,
  MALLET_R,
  MAX_SPEED,
  PUCK_R,
  STEP,
  TABLE,
  WIN_SCORE,
  clampMallet,
  collide,
  goalAt,
  initialWorld,
  malletBox,
  malletHome,
  moveMallet,
  plausibleGoal,
  plausibleMove,
  servedPuck,
  step,
  winner,
  type World,
} from './physics.ts';
import { frameOf, frameOp, resultMatchesLive, type AirHockeyDoc } from './logic.ts';

const still = (w: World) => ({ host: w.host, guest: w.guest });

function run(world: World, steps: number, targets = still(world)): { world: World; goals: string[] } {
  const goals: string[] = [];
  for (let i = 0; i < steps; i++) {
    const r = step(world, targets.host, targets.guest);
    world = r.world;
    if (r.goal) goals.push(r.goal);
  }
  return { world, goals };
}

describe('air hockey physics', () => {
  test('mallets stay in their own half', () => {
    expect(clampMallet('host', { x: -10, y: 0 })).toEqual({ x: MALLET_R, y: TABLE.height / 2 + MALLET_R });
    expect(clampMallet('guest', { x: 500, y: 500 })).toEqual({ x: TABLE.width - MALLET_R, y: TABLE.height / 2 - MALLET_R });
    const box = malletBox('guest');
    expect(box.maxY).toBeLessThan(TABLE.height / 2);
  });

  test('a mallet moves toward its target at most MALLET_SPEED per second', () => {
    const from = malletHome('host');
    const to = moveMallet('host', from, { x: from.x, y: TABLE.height / 2 + 10 }, STEP);
    expect(from.y - to.y).toBeCloseTo(4, 5);
    expect(moveMallet('host', from, { x: from.x + 1, y: from.y }, STEP)).toEqual({ x: from.x + 1, y: from.y });
  });

  test('a still puck stays put and the world ticks', () => {
    const { world, goals } = run(initialWorld(), 30);
    expect(world.puck).toEqual(initialWorld().puck);
    expect(world.tick).toBe(30);
    expect(goals).toEqual([]);
  });

  test('the puck bounces off the side walls and slows by friction', () => {
    const w = { ...initialWorld(), puck: { x: 10, y: 64, vx: -120, vy: 0 } };
    const { world } = run(w, 20);
    expect(world.puck.vx).toBeGreaterThan(0);
    expect(world.puck.vx).toBeLessThan(120);
    expect(world.puck.x).toBeGreaterThanOrEqual(PUCK_R);
  });

  test('the puck bounces off an end wall outside the mouth', () => {
    const w = { ...initialWorld(), puck: { x: 12, y: 10, vx: 0, vy: -150 } };
    const { world, goals } = run(w, 20);
    expect(goals).toEqual([]);
    expect(world.puck.vy).toBeGreaterThan(0);
  });

  test('a puck through the top mouth is a goal for the host, served to the guest', () => {
    const w = { ...initialWorld(), puck: { x: 38, y: 20, vx: 0, vy: -170 } };
    const { world, goals } = run(w, 20);
    expect(goals).toEqual(['host']);
    expect(world.score).toEqual({ host: 1, guest: 0 });
    expect(world.puck).toEqual(servedPuck('guest'));
  });

  test('a puck through the bottom mouth is a goal for the guest', () => {
    const w = { ...initialWorld(), puck: { x: 40, y: 100, vx: 0, vy: 170 } };
    const { world, goals } = run(w, 20, { host: { x: 90, y: 70 }, guest: malletHome('guest') });
    expect(goals).toEqual(['guest']);
    expect(world.score).toEqual({ host: 0, guest: 1 });
    expect(world.puck).toEqual(servedPuck('host'));
  });

  test('goalAt names the scorer by the end line crossed', () => {
    expect(goalAt({ x: 48, y: -0.1 })).toBe('host');
    expect(goalAt({ x: 48, y: TABLE.height + 0.1 })).toBe('guest');
    expect(goalAt({ x: 48, y: 64 })).toBeNull();
    expect(GOAL_LEFT).toBeLessThan(GOAL_RIGHT);
  });

  test('a mallet hits the puck away at no more than top speed', () => {
    const hit = collide({ x: 48, y: 90, vx: 0, vy: 0 }, { x: 48, y: 96 }, 0, -600);
    expect(hit.vy).toBeLessThan(0);
    expect(Math.hypot(hit.vx, hit.vy)).toBeLessThanOrEqual(MAX_SPEED + 1e-9);
    expect(hit.y).toBeCloseTo(96 - PUCK_R - MALLET_R, 9);
  });

  test('the host can drive the puck into the guest goal from a serve', () => {
    let world: World = { ...initialWorld(), puck: servedPuck('host') };
    let goals: string[] = [];
    for (let i = 0; i < 400 && goals.length === 0; i++) {
      const behind = { x: world.puck.x, y: world.puck.y + 6 };
      const r = step(world, behind, { x: 90, y: 8 });
      world = r.world;
      if (r.goal) goals = [r.goal];
    }
    expect(goals).toEqual(['host']);
  });

  test('the world stops once a side has won', () => {
    const w = { ...initialWorld(), score: { host: WIN_SCORE, guest: 3 }, puck: { x: 48, y: 64, vx: 50, vy: 50 } };
    expect(winner(w.score)).toBe('host');
    expect(step(w, w.host, w.guest).world).toBe(w);
  });

  test('replay checks: a puck jump and a goal from mid-table are implausible', () => {
    expect(plausibleMove({ x: 48, y: 64 }, { x: 50, y: 64 }, 1)).toBe(true);
    expect(plausibleMove({ x: 48, y: 64 }, { x: 48, y: 20 }, 3)).toBe(false);
    expect(plausibleGoal({ x: 48, y: 2 }, 'host', servedPuck('guest'), 3)).toBe(true);
    expect(plausibleGoal({ x: 48, y: 64 }, 'host', servedPuck('guest'), 3)).toBe(false);
    expect(plausibleGoal({ x: 48, y: 2 }, 'host', { ...servedPuck('guest'), x: 10 }, 3)).toBe(false);
  });
});

describe('air hockey writes', () => {
  test('a frame rounds positions and never reads faster than top speed', () => {
    const w = { ...initialWorld(), puck: { x: 1.23456, y: 2.34567, vx: MAX_SPEED / Math.SQRT2, vy: -MAX_SPEED / Math.SQRT2 } };
    const f = frameOf(w);
    expect(f.puck.x).toBe(1.23);
    expect(Math.hypot(f.puck.vx, f.puck.vy)).toBeLessThanOrEqual(MAX_SPEED);
  });

  test('the winning frame closes the live match', () => {
    const w = { ...initialWorld(), score: { host: WIN_SCORE, guest: 2 } };
    const op = frameOp('m', 'h', w, true);
    expect(op.type === 'update' && op.value['meta/status']).toBe('over');
    expect(op.type === 'update' && op.value['meta/winner']).toBe('host');
    const plain = frameOp('m', 'h', { ...w, score: { host: 1, guest: 2 } }, false);
    expect(plain.type === 'update' && 'score' in plain.value).toBe(false);
  });

  test('a result must agree with the live match', () => {
    const doc = { status: 'won', winner: 'host', score: { host: 7, guest: 2 }, endedBy: 'goals' } as unknown as AirHockeyDoc;
    const live = { meta: { guest: 'g', status: 'over' as const, winner: 'host' as const }, score: { host: 7, guest: 2 } };
    expect(resultMatchesLive(doc, live)).toBe(true);
    expect(resultMatchesLive({ ...doc, score: { host: 7, guest: 0 } }, live)).toBe(false);
    const forfeit = { ...doc, endedBy: 'forfeit', score: { host: 1, guest: 0 } } as AirHockeyDoc;
    expect(resultMatchesLive(forfeit, live)).toBe(false);
    expect(resultMatchesLive(forfeit, { meta: { guest: 'g', status: 'forfeit', winner: 'host' } })).toBe(true);
  });
});
