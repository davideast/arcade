/**
 * Breadth-first Sokoban search, for tests and tools: the fewest-moves
 * solution of a level, and the fewest pushes any solution needs. A box
 * pushed into a corner that is not a goal can never leave it, so those
 * positions are cut.
 */
import { DIRS, letter, neighbor, step, isSolved, type Level, type Position } from './sokoban.ts';

const keyOf = (p: Position) => `${p.player}:${p.boxes.join(',')}`;

function deadCorners(level: Level): boolean[] {
  const { width, height, walls, goals } = level;
  const wall = (i: number) => i < 0 || walls[i];
  return walls.map((w, i) => {
    if (w || goals.includes(i)) return false;
    const l = wall(neighbor(width, height, i, 'l'));
    const r = wall(neighbor(width, height, i, 'r'));
    const u = wall(neighbor(width, height, i, 'u'));
    const d = wall(neighbor(width, height, i, 'd'));
    return (l || r) && (u || d);
  });
}

/** The fewest-moves solution, as LURD text, or null when the level has none. */
export function solveMoves(level: Level): string | null {
  const dead = deadCorners(level);
  const seen = new Map<string, { from: string; step: string }>();
  const start = keyOf(level.start);
  seen.set(start, { from: '', step: '' });
  let frontier: Position[] = [level.start];
  while (frontier.length > 0) {
    const next: Position[] = [];
    for (const pos of frontier) {
      const k = keyOf(pos);
      if (isSolved(level, pos)) {
        let path = '';
        for (let at = k; at !== start; at = seen.get(at)!.from) path = seen.get(at)!.step + path;
        return path;
      }
      for (const d of DIRS) {
        const s = step(level, pos, d);
        if (!s || (s.pushed && s.position.boxes.some((b) => dead[b]))) continue;
        const nk = keyOf(s.position);
        if (seen.has(nk)) continue;
        seen.set(nk, { from: k, step: letter(d, s.pushed) });
        next.push(s.position);
      }
    }
    frontier = next;
  }
  return null;
}

/** The fewest pushes any solution needs (walks are free), or -1 when there is none. */
export function minPushes(level: Level): number {
  const dead = deadCorners(level);
  const best = new Map<string, number>();
  const deque: Array<[Position, number]> = [[level.start, 0]];
  best.set(keyOf(level.start), 0);
  while (deque.length > 0) {
    const [pos, pushes] = deque.shift()!;
    if (pushes > (best.get(keyOf(pos)) ?? Infinity)) continue;
    if (isSolved(level, pos)) return pushes;
    for (const d of DIRS) {
      const s = step(level, pos, d);
      if (!s || (s.pushed && s.position.boxes.some((b) => dead[b]))) continue;
      const cost = pushes + (s.pushed ? 1 : 0);
      const nk = keyOf(s.position);
      if (cost >= (best.get(nk) ?? Infinity)) continue;
      best.set(nk, cost);
      if (s.pushed) deque.push([s.position, cost]);
      else deque.unshift([s.position, cost]);
    }
  }
  return -1;
}
