/**
 * Air hockey physics, pure and deterministic. The host runs it; the guest
 * only renders what the host writes.
 *
 * The table is TABLE.width by TABLE.height logical pixels, with the host's
 * goal at the bottom (y = height) and the guest's at the top (y = 0). Each
 * goal is a mouth in the end wall between GOAL_LEFT and GOAL_RIGHT. Each
 * mallet stays in its own half. A puck whose center crosses an end line
 * inside the mouth is a goal for the other side.
 */

export type Side = 'host' | 'guest';

export interface Vec {
  x: number;
  y: number;
}

export interface Puck extends Vec {
  vx: number;
  vy: number;
}

export interface Score {
  host: number;
  guest: number;
}

export interface World {
  puck: Puck;
  host: Vec;
  guest: Vec;
  score: Score;
  /** Simulation steps since the match started. */
  tick: number;
}

export const TABLE = { width: 96, height: 128 } as const;
export const GOAL_LEFT = 32;
export const GOAL_RIGHT = 64;
export const PUCK_R = 3.5;
export const MALLET_R = 4.5;
/** The puck's top speed, in pixels per second, along each axis and overall. */
export const MAX_SPEED = 180;
/** How far a mallet moves toward its target in one second. */
export const MALLET_SPEED = 240;
/** Fixed simulation step, in seconds. */
export const STEP = 1 / 60;
export const WIN_SCORE = 7;
const RESTITUTION = 0.9;
const FRICTION = 0.996;

export function otherSide(side: Side): Side {
  return side === 'host' ? 'guest' : 'host';
}

/** The box a side's mallet center stays in: x across the table, y in its own half. */
export function malletBox(side: Side): { minX: number; maxX: number; minY: number; maxY: number } {
  const half = TABLE.height / 2;
  return side === 'host'
    ? { minX: MALLET_R, maxX: TABLE.width - MALLET_R, minY: half + MALLET_R, maxY: TABLE.height - MALLET_R }
    : { minX: MALLET_R, maxX: TABLE.width - MALLET_R, minY: MALLET_R, maxY: half - MALLET_R };
}

export function clampMallet(side: Side, p: Vec): Vec {
  const b = malletBox(side);
  return { x: clamp(p.x, b.minX, b.maxX), y: clamp(p.y, b.minY, b.maxY) };
}

export function malletHome(side: Side): Vec {
  return { x: TABLE.width / 2, y: side === 'host' ? TABLE.height - 16 : 16 };
}

/** The puck at rest in the middle of `side`'s half, served to the side that conceded. */
export function servedPuck(side: Side): Puck {
  return { x: TABLE.width / 2, y: side === 'host' ? (TABLE.height * 3) / 4 : TABLE.height / 4, vx: 0, vy: 0 };
}

export function initialWorld(): World {
  return {
    puck: { x: TABLE.width / 2, y: TABLE.height / 2, vx: 0, vy: 0 },
    host: malletHome('host'),
    guest: malletHome('guest'),
    score: { host: 0, guest: 0 },
    tick: 0,
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function inMouth(x: number): boolean {
  return x - PUCK_R >= GOAL_LEFT && x + PUCK_R <= GOAL_RIGHT;
}

/** Move a mallet toward its target, at most MALLET_SPEED * dt, inside its box. */
export function moveMallet(side: Side, from: Vec, target: Vec, dt: number): Vec {
  const goal = clampMallet(side, target);
  const dx = goal.x - from.x;
  const dy = goal.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const reach = MALLET_SPEED * dt;
  if (dist <= reach) return goal;
  return clampMallet(side, { x: from.x + (dx / dist) * reach, y: from.y + (dy / dist) * reach });
}

function capSpeed(p: Puck): Puck {
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  if (speed <= MAX_SPEED) return p;
  return { ...p, vx: (p.vx / speed) * MAX_SPEED, vy: (p.vy / speed) * MAX_SPEED };
}

/** Bounce the puck off a mallet moving with velocity (mvx, mvy). */
export function collide(puck: Puck, mallet: Vec, mvx: number, mvy: number): Puck {
  const dx = puck.x - mallet.x;
  const dy = puck.y - mallet.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const reach = PUCK_R + MALLET_R;
  if (dist >= reach) return puck;
  // A puck exactly on the mallet's center goes straight away from the mallet's side of the table.
  const nx = dist === 0 ? 0 : dx / dist;
  const ny = dist === 0 ? (mallet.y > TABLE.height / 2 ? -1 : 1) : dy / dist;
  let { vx, vy } = puck;
  const rvx = vx - mvx;
  const rvy = vy - mvy;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    vx -= (1 + RESTITUTION) * vn * nx;
    vy -= (1 + RESTITUTION) * vn * ny;
  }
  return capSpeed({ x: mallet.x + nx * reach, y: mallet.y + ny * reach, vx, vy });
}

/** Keep the puck on the table: bounce off the side walls and the end walls outside the mouths. */
function walls(p: Puck): Puck {
  let { x, y, vx, vy } = p;
  if (x < PUCK_R) {
    x = PUCK_R;
    vx = Math.abs(vx) * RESTITUTION;
  } else if (x > TABLE.width - PUCK_R) {
    x = TABLE.width - PUCK_R;
    vx = -Math.abs(vx) * RESTITUTION;
  }
  if (!inMouth(x)) {
    if (y < PUCK_R) {
      y = PUCK_R;
      vy = Math.abs(vy) * RESTITUTION;
    } else if (y > TABLE.height - PUCK_R) {
      y = TABLE.height - PUCK_R;
      vy = -Math.abs(vy) * RESTITUTION;
    }
  }
  return { x, y, vx, vy };
}

/** The side that scores when the puck is at `p`, or null. */
export function goalAt(p: Vec): Side | null {
  if (p.y < 0) return 'host';
  if (p.y > TABLE.height) return 'guest';
  return null;
}

export interface StepResult {
  world: World;
  /** The side that scored in this step, or null. */
  goal: Side | null;
}

/**
 * Advance one STEP: mallets move toward their targets, the puck moves,
 * bounces off the walls and both mallets, and slows by friction. A goal adds
 * one to the scorer and serves the puck to the side that conceded; once a
 * side has WIN_SCORE the world no longer changes.
 */
export function step(world: World, hostTarget: Vec, guestTarget: Vec): StepResult {
  if (winner(world.score)) return { world, goal: null };
  const host = moveMallet('host', world.host, hostTarget, STEP);
  const guest = moveMallet('guest', world.guest, guestTarget, STEP);
  let puck: Puck = {
    x: world.puck.x + world.puck.vx * STEP,
    y: world.puck.y + world.puck.vy * STEP,
    vx: world.puck.vx * FRICTION,
    vy: world.puck.vy * FRICTION,
  };
  puck = walls(puck);
  puck = collide(puck, host, (host.x - world.host.x) / STEP, (host.y - world.host.y) / STEP);
  puck = collide(puck, guest, (guest.x - world.guest.x) / STEP, (guest.y - world.guest.y) / STEP);
  puck = walls(puck);
  const tick = world.tick + 1;
  const goal = goalAt(puck);
  if (goal) {
    const score = { ...world.score, [goal]: world.score[goal] + 1 };
    return { world: { puck: servedPuck(otherSide(goal)), host, guest, score, tick }, goal };
  }
  return { world: { puck, host, guest, score: world.score, tick }, goal: null };
}

export function winner(score: Score): Side | null {
  if (score.host >= WIN_SCORE) return 'host';
  if (score.guest >= WIN_SCORE) return 'guest';
  return null;
}

/** Round to hundredths, the precision the host writes. */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Whether the puck at `to`, `ticks` steps after `from`, could have got
 * there: in a step it moves at most MAX_SPEED / 60 on its own, plus as far
 * as a mallet pushing it moved (MALLET_SPEED / 60), plus a pixel of slack for
 * rounding and bounces. A goal serves the puck, so a frame that carries a
 * new score is checked by `plausibleGoal` instead.
 */
export function plausibleMove(from: Vec, to: Vec, ticks: number): boolean {
  if (ticks <= 0) return from.x === to.x && from.y === to.y;
  const reach = (MAX_SPEED + MALLET_SPEED) * STEP * ticks + 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * Whether a goal for `scorer` could follow the puck frame `last`, `ticks`
 * steps earlier: the puck must have been able to reach the end line inside
 * the mouth, and the new puck must be the serve.
 */
export function plausibleGoal(last: Vec, scorer: Side, served: Puck, ticks: number): boolean {
  const reach = (MAX_SPEED + MALLET_SPEED) * STEP * Math.max(ticks, 1) + 1;
  const toLine = scorer === 'host' ? last.y : TABLE.height - last.y;
  const expected = servedPuck(otherSide(scorer));
  const mouthX = clamp(last.x, GOAL_LEFT, GOAL_RIGHT);
  const dx = last.x - mouthX;
  return toLine <= reach && Math.sqrt(dx * dx + toLine * toLine) <= reach + PUCK_R
    && served.x === expected.x && served.y === expected.y && served.vx === 0 && served.vy === 0;
}
