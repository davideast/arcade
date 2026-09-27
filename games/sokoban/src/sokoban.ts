/**
 * Sokoban rules of play, pure: parse a level, step the player, push boxes,
 * tell a solved position, and replay a move list.
 *
 * A move list is LURD text: one letter per step, `l` `u` `r` `d` for a walk
 * and `L` `U` `R` `D` for a step that pushes a box. Its length is the move
 * count and its capitals are the push count.
 */

export type Dir = 'l' | 'u' | 'r' | 'd';
export const DIRS: readonly Dir[] = ['l', 'u', 'r', 'd'];

export interface Level {
  width: number;
  height: number;
  /** Per cell, row-major: true for a wall. */
  walls: boolean[];
  goals: number[];
  /** The cells inside the walls, reachable by the player; floor is drawn only here. */
  floor: boolean[];
  start: Position;
}

export interface Position {
  player: number;
  /** Box cells, sorted. */
  boxes: number[];
}

export function parseLevel(rows: string[]): Level {
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const walls: boolean[] = Array(width * height).fill(false);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const c = row[x] ?? ' ';
      const i = y * width + x;
      if (c === '#') walls[i] = true;
      if (c === '.' || c === '*' || c === '+') goals.push(i);
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') {
        if (player >= 0) throw new Error('A level has one player.');
        player = i;
      }
      if (!'#.$*@+ -_'.includes(c)) throw new Error(`Unknown level character ${JSON.stringify(c)}.`);
    }
  });
  if (player < 0) throw new Error('A level needs a player.');
  if (boxes.length === 0 || boxes.length !== goals.length) throw new Error('A level needs as many boxes as goals.');
  const floor: boolean[] = Array(width * height).fill(false);
  const queue = [player];
  floor[player] = true;
  while (queue.length > 0) {
    const at = queue.pop()!;
    for (const d of DIRS) {
      const next = neighbor(width, height, at, d);
      if (next >= 0 && !walls[next] && !floor[next]) {
        floor[next] = true;
        queue.push(next);
      }
    }
  }
  return { width, height, walls, goals: goals.sort((a, b) => a - b), floor, start: { player, boxes: boxes.sort((a, b) => a - b) } };
}

/** The cell one step from `at` in `d`, or -1 off the grid. */
export function neighbor(width: number, height: number, at: number, d: Dir): number {
  const x = at % width;
  const y = Math.floor(at / width);
  const [nx, ny] = d === 'l' ? [x - 1, y] : d === 'r' ? [x + 1, y] : d === 'u' ? [x, y - 1] : [x, y + 1];
  return nx < 0 || ny < 0 || nx >= width || ny >= height ? -1 : ny * width + nx;
}

export interface Step {
  position: Position;
  pushed: boolean;
}

/** One step in `d` from `pos`, or null when a wall or a blocked box stops it. */
export function step(level: Level, pos: Position, d: Dir): Step | null {
  const to = neighbor(level.width, level.height, pos.player, d);
  if (to < 0 || level.walls[to]) return null;
  const box = pos.boxes.indexOf(to);
  if (box < 0) return { position: { player: to, boxes: pos.boxes }, pushed: false };
  const beyond = neighbor(level.width, level.height, to, d);
  if (beyond < 0 || level.walls[beyond] || pos.boxes.includes(beyond)) return null;
  const boxes = pos.boxes.slice();
  boxes[box] = beyond;
  boxes.sort((a, b) => a - b);
  return { position: { player: to, boxes }, pushed: true };
}

export function isSolved(level: Level, pos: Position): boolean {
  return pos.boxes.every((b, i) => b === level.goals[i]);
}

/** The LURD letter for a step: capital when it pushed. */
export function letter(d: Dir, pushed: boolean): string {
  return pushed ? d.toUpperCase() : d;
}

export function countPushes(moves: string): number {
  let n = 0;
  for (const c of moves) if (c >= 'A' && c <= 'Z') n++;
  return n;
}

export type Replay =
  | { ok: true; moves: number; pushes: number; position: Position }
  | { ok: false; reason: string; at: number };

/**
 * Replay a move list from the level's start. It must use only LURD letters,
 * every step must be possible, a letter's case must say whether it pushed,
 * the last step must solve the level, and no step may come after that.
 */
export function replay(level: Level, moves: string): Replay {
  let pos = level.start;
  let pushes = 0;
  for (let i = 0; i < moves.length; i++) {
    const c = moves[i];
    const d = c.toLowerCase() as Dir;
    if (!DIRS.includes(d)) return { ok: false, reason: `move ${i + 1} is not a LURD letter`, at: i };
    if (isSolved(level, pos)) return { ok: false, reason: `move ${i + 1} comes after the level is solved`, at: i };
    const next = step(level, pos, d);
    if (!next) return { ok: false, reason: `move ${i + 1} walks into a wall or a blocked box`, at: i };
    if (next.pushed !== (c !== d)) return { ok: false, reason: `move ${i + 1} ${next.pushed ? 'pushes a box but is written as a walk' : 'is written as a push but moves no box'}`, at: i };
    if (next.pushed) pushes++;
    pos = next.position;
  }
  if (!isSolved(level, pos)) return { ok: false, reason: 'the moves do not solve the level', at: moves.length };
  return { ok: true, moves: moves.length, pushes, position: pos };
}

/** A game in progress: the moves made so far, with undo and restart. */
export class Play {
  private positions: Position[];
  private letters: string[] = [];

  constructor(readonly level: Level) {
    this.positions = [level.start];
  }

  get position(): Position {
    return this.positions[this.positions.length - 1];
  }

  get moves(): string {
    return this.letters.join('');
  }

  get moveCount(): number {
    return this.letters.length;
  }

  get pushCount(): number {
    return countPushes(this.moves);
  }

  get solved(): boolean {
    return isSolved(this.level, this.position);
  }

  /** Step in `d`; returns false when the step is blocked or the level is already solved. */
  go(d: Dir): boolean {
    if (this.solved) return false;
    const next = step(this.level, this.position, d);
    if (!next) return false;
    this.positions.push(next.position);
    this.letters.push(letter(d, next.pushed));
    return true;
  }

  undo(): boolean {
    if (this.letters.length === 0) return false;
    this.positions.pop();
    this.letters.pop();
    return true;
  }

  restart(): void {
    this.positions = [this.level.start];
    this.letters = [];
  }
}
