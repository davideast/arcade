/**
 * A simple player for tests and browser checks: while the puck is in its
 * half, a side lines its mallet up behind the puck on the line from the goal
 * it attacks, then strikes through it; otherwise it parks at `guard`.
 */
import { GOAL_LEFT, GOAL_RIGHT, TABLE, clampMallet, malletHome, type Side, type Vec, type World } from './physics.ts';

export interface Plan {
  /** Where in the goal mouth to aim, from -1 (left post) to 1 (right post). */
  aim: number;
  /** The x the mallet waits at while the puck is in the other half. */
  guard: number;
}

export function autopilot(side: Side, world: World, plan: Plan): Vec {
  const { puck } = world;
  const mallet = world[side];
  const mine = side === 'host' ? puck.y >= TABLE.height / 2 : puck.y < TABLE.height / 2;
  if (!mine) return clampMallet(side, { x: plan.guard, y: malletHome(side).y });
  const goal = { x: (GOAL_LEFT + GOAL_RIGHT) / 2 + (plan.aim * (GOAL_RIGHT - GOAL_LEFT)) / 3, y: side === 'host' ? 0 : TABLE.height };
  const dx = puck.x - goal.x;
  const dy = puck.y - goal.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  // A fast puck can't be lined up: meet it from the goal side of its path.
  if (Math.hypot(puck.vx, puck.vy) > 60) return clampMallet(side, { x: puck.x + ux * 4, y: puck.y + uy * 4 });
  const stage = { x: puck.x + ux * 12, y: puck.y + uy * 12 };
  // On the line behind the puck (farther from the goal than it is): strike through it.
  const along = (mallet.x - puck.x) * ux + (mallet.y - puck.y) * uy;
  const across = (mallet.x - puck.x) * -uy + (mallet.y - puck.y) * ux;
  if (along > 6 && Math.abs(across) < 0.75) return clampMallet(side, { x: puck.x - ux * 10, y: puck.y - uy * 10 });
  return clampMallet(side, stage);
}
