/**
 * Deterministic pool physics. A shot's result depends only on the table before
 * it and the shot, and the arithmetic is limited to + - * / and Math.sqrt,
 * which IEEE 754 defines exactly, so every client replays a shot to the same
 * table. Positions are stored as integers in hundredths of a pixel; a shot
 * starts from the stored integers and its result is rounded back to them.
 *
 * Coordinates are table-local pixels: the cloth runs from (0, 0) to
 * (TABLE_WIDTH, TABLE_HEIGHT).
 */

export const TABLE_WIDTH = 112;
export const TABLE_HEIGHT = 60;
export const BALL_RADIUS = 3;
export const BALL_COUNT = 16;
/** Stored coordinate of a ball that is off the table. */
export const OFF_TABLE = -1;

const POCKETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 5.5],
  [TABLE_WIDTH / 2, -2, 5.5],
  [TABLE_WIDTH, 0, 5.5],
  [0, TABLE_HEIGHT, 5.5],
  [TABLE_WIDTH / 2, TABLE_HEIGHT + 2, 5.5],
  [TABLE_WIDTH, TABLE_HEIGHT, 5.5],
];
export const POCKET_CENTERS = POCKETS.map(([x, y]) => [x, y] as const);

const SUBSTEPS = 4;
const MAX_STEPS = 3000;
const MAX_SPEED = 4;
const ROLLING_DRAG = 0.992;
const ROLLING_LOSS = 0.002;
const STOP_SPEED = 0.005;
const CUSHION = 0.8;
const RESTITUTION = 0.95;

/** Where the cue ball starts, and returns to after a scratch. */
export const HEAD_SPOT = { x: 28, y: 30 };
const FOOT_SPOT = { x: 80, y: 30 };

/** Rack order by row, apex first; the 8 sits in the middle of the third row. */
const RACK_ROWS = [[1], [9, 2], [10, 8, 3], [11, 7, 14, 4], [5, 13, 15, 6, 12]];

/** The opening table as stored: ball n's x and y at indexes 2n and 2n + 1. */
export const RACK: readonly number[] = (() => {
  const balls = Array<number>(BALL_COUNT * 2).fill(0);
  balls[0] = HEAD_SPOT.x * 100;
  balls[1] = HEAD_SPOT.y * 100;
  RACK_ROWS.forEach((row, r) => {
    row.forEach((n, k) => {
      balls[n * 2] = FOOT_SPOT.x * 100 + r * 520;
      balls[n * 2 + 1] = FOOT_SPOT.y * 100 + Math.round((k - r / 2) * 605);
    });
  });
  return balls;
})();

export interface Shot {
  /** Aim direction; any nonzero integer vector with components in [-1000, 1000]. */
  dx: number;
  dy: number;
  /** 1 to 100. */
  power: number;
}

export interface ShotResult {
  balls: number[];
  /** Object balls on the table before the shot that finished in a pocket. */
  newlyPotted: number[];
  scratch: boolean;
  /** Ball positions in pixels after each step, for animation. */
  frames: Float64Array[];
}

export function validShot(shot: Shot): boolean {
  const ints = [shot.dx, shot.dy, shot.power].every(Number.isInteger);
  return ints && shot.power >= 1 && shot.power <= 100
    && Math.abs(shot.dx) <= 1000 && Math.abs(shot.dy) <= 1000
    && (shot.dx !== 0 || shot.dy !== 0);
}

/**
 * Play `shot` on the stored table. `potted` lists object balls already off the
 * table; the cue ball is always on it.
 */
export function simulate(balls: readonly number[], potted: readonly number[], shot: Shot): ShotResult {
  const on = Array.from({ length: BALL_COUNT }, (_, n) => n === 0 || !potted.includes(n));
  const x = new Float64Array(BALL_COUNT);
  const y = new Float64Array(BALL_COUNT);
  const vx = new Float64Array(BALL_COUNT);
  const vy = new Float64Array(BALL_COUNT);
  for (let n = 0; n < BALL_COUNT; n++) {
    x[n] = balls[n * 2] / 100;
    y[n] = balls[n * 2 + 1] / 100;
  }
  const length = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy);
  const speed = (shot.power / 100) * MAX_SPEED;
  vx[0] = (shot.dx / length) * speed;
  vy[0] = (shot.dy / length) * speed;

  const sunk: number[] = [];
  const frames: Float64Array[] = [];
  const snapshot = () => {
    const frame = new Float64Array(BALL_COUNT * 2);
    for (let n = 0; n < BALL_COUNT; n++) {
      frame[n * 2] = on[n] ? x[n] : OFF_TABLE;
      frame[n * 2 + 1] = on[n] ? y[n] : OFF_TABLE;
    }
    frames.push(frame);
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    let moving = false;
    for (let n = 0; n < BALL_COUNT; n++) if (on[n] && (vx[n] !== 0 || vy[n] !== 0)) moving = true;
    if (!moving) break;

    for (let sub = 0; sub < SUBSTEPS; sub++) {
      for (let n = 0; n < BALL_COUNT; n++) {
        if (!on[n]) continue;
        x[n] += vx[n] / SUBSTEPS;
        y[n] += vy[n] / SUBSTEPS;
        if (inPocket(x[n], y[n])) {
          on[n] = false;
          vx[n] = 0;
          vy[n] = 0;
          sunk.push(n);
          continue;
        }
        cushion(n, x, vx, TABLE_WIDTH);
        cushion(n, y, vy, TABLE_HEIGHT);
      }
      collide(on, x, y, vx, vy);
    }

    for (let n = 0; n < BALL_COUNT; n++) {
      if (!on[n]) continue;
      const s = Math.sqrt(vx[n] * vx[n] + vy[n] * vy[n]);
      if (s === 0) continue;
      const next = s * ROLLING_DRAG - ROLLING_LOSS;
      if (next <= STOP_SPEED) {
        vx[n] = 0;
        vy[n] = 0;
      } else {
        vx[n] = (vx[n] * next) / s;
        vy[n] = (vy[n] * next) / s;
      }
    }
    snapshot();
  }

  const out = Array<number>(BALL_COUNT * 2).fill(OFF_TABLE);
  for (let n = 0; n < BALL_COUNT; n++) {
    if (!on[n]) continue;
    out[n * 2] = Math.round(x[n] * 100);
    out[n * 2 + 1] = Math.round(y[n] * 100);
  }
  const scratch = sunk.includes(0);
  if (scratch) {
    const [cx, cy] = freeSpot(out);
    out[0] = cx;
    out[1] = cy;
    snapshot();
    const last = frames[frames.length - 1];
    last[0] = cx / 100;
    last[1] = cy / 100;
  }
  return { balls: out, newlyPotted: sunk.filter((n) => n !== 0).sort((a, b) => a - b), scratch, frames };
}

function inPocket(px: number, py: number): boolean {
  for (const [cx, cy, r] of POCKETS) {
    const dx = px - cx;
    const dy = py - cy;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

function cushion(n: number, p: Float64Array, v: Float64Array, max: number): void {
  if (p[n] < BALL_RADIUS) {
    p[n] = 2 * BALL_RADIUS - p[n];
    v[n] = -v[n] * CUSHION;
  } else if (p[n] > max - BALL_RADIUS) {
    p[n] = 2 * (max - BALL_RADIUS) - p[n];
    v[n] = -v[n] * CUSHION;
  }
}

function collide(on: boolean[], x: Float64Array, y: Float64Array, vx: Float64Array, vy: Float64Array): void {
  const min = 2 * BALL_RADIUS;
  for (let i = 0; i < BALL_COUNT; i++) {
    if (!on[i]) continue;
    for (let j = i + 1; j < BALL_COUNT; j++) {
      if (!on[j]) continue;
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const push = (min - d) / 2;
      x[i] -= nx * push;
      y[i] -= ny * push;
      x[j] += nx * push;
      y[j] += ny * push;
      const approach = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
      if (approach <= 0) continue;
      const impulse = (approach * (1 + RESTITUTION)) / 2;
      vx[i] -= impulse * nx;
      vy[i] -= impulse * ny;
      vx[j] += impulse * nx;
      vy[j] += impulse * ny;
    }
  }
}

/** The head spot, or the nearest point left or right of it along the head string that no ball touches. */
function freeSpot(balls: number[]): [number, number] {
  const clear = (px: number, py: number) => {
    for (let n = 1; n < BALL_COUNT; n++) {
      if (balls[n * 2] === OFF_TABLE) continue;
      const dx = balls[n * 2] - px;
      const dy = balls[n * 2 + 1] - py;
      if (dx * dx + dy * dy < 700 * 700) return false;
    }
    return true;
  };
  const hx = HEAD_SPOT.x * 100;
  const hy = HEAD_SPOT.y * 100;
  for (let k = 0; k < 40; k++) {
    for (const px of [hx - k * 100, hx + k * 100]) {
      if (px >= BALL_RADIUS * 100 && px <= (TABLE_WIDTH - BALL_RADIUS) * 100 && clear(px, hy)) return [px, hy];
    }
  }
  return [hx, hy];
}
