/**
 * Battleship on a 10x10 grid. Cells are numbered row * 10 + column.
 *
 * Each player's fleet is a private document only its owner can read, and it
 * can't change once written. A shot is a create-only document whose `hit` the
 * Security Rules check against the defender's fleet with `get()`, which rules
 * may read even though the attacker can't. So both hidden placement and
 * truthful answers are enforced, not trusted.
 *
 * Players alternate one shot per turn; a hit doesn't grant another shot.
 */
import type { Seat } from '@games/turn-net/types';

export const COLLECTION = 'battleship';
export const SIZE = 10;
/** Carrier, battleship, cruiser, submarine, destroyer. */
export const FLEET = [5, 4, 3, 3, 2] as const;
export const FLEET_CELLS = FLEET.reduce((a, b) => a + b, 0);
export const SHIP_NAMES = ['Carrier', 'Battleship', 'Cruiser', 'Submarine', 'Destroyer'];

export type Dir = 'h' | 'v';

export interface Placement {
  start: number;
  dir: Dir;
}

/** The fleet document: ship starts and directions, and every occupied cell in ship order. */
export interface BoardDoc {
  starts: number[];
  dirs: Dir[];
  cells: number[];
}

export type Status = 'waiting' | 'placing' | 'playing' | 'won' | 'resigned';

export interface BattleshipMatch {
  host: string;
  guest: string;
  currentTurn: Seat;
  status: Status;
  winner: '' | Seat;
  moveCount: number;
  hostReady: boolean;
  guestReady: boolean;
  /** Hits scored by each seat. */
  hostHits: number;
  guestHits: number;
  /** Id of the latest shot document, '' before the first. */
  lastShot: string;
}

export interface ShotDoc {
  by: string;
  cell: number;
  hit: boolean;
}

export type WriteOp =
  | { type: 'set'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> };

export function matchPath(id: string): string {
  return `${COLLECTION}/${id}`;
}

export function shipCells(length: number, { start, dir }: Placement): number[] {
  const step = dir === 'h' ? 1 : SIZE;
  return Array.from({ length }, (_, k) => start + k * step);
}

export function inBounds(length: number, { start, dir }: Placement): boolean {
  if (!Number.isInteger(start) || start < 0 || start >= SIZE * SIZE) return false;
  return dir === 'h' ? (start % SIZE) + length - 1 < SIZE : start + (length - 1) * SIZE < SIZE * SIZE;
}

/** Whether ship `index` can go at `placement` alongside the ships already placed. */
export function canPlace(placed: Placement[], index: number, placement: Placement): boolean {
  if (!inBounds(FLEET[index], placement)) return false;
  const taken = new Set(placed.flatMap((p, i) => shipCells(FLEET[i], p)));
  return shipCells(FLEET[index], placement).every((c) => !taken.has(c));
}

export function boardDoc(placements: Placement[]): BoardDoc {
  return {
    starts: placements.map((p) => p.start),
    dirs: placements.map((p) => p.dir),
    cells: placements.flatMap((p, i) => shipCells(FLEET[i], p)),
  };
}

export function validFleet(placements: Placement[]): boolean {
  if (placements.length !== FLEET.length) return false;
  for (let i = 0; i < FLEET.length; i++) if (!canPlace(placements.slice(0, i), i, placements[i])) return false;
  return true;
}

/** A random legal fleet from `random` (a function returning [0, 1)). */
export function randomFleet(random: () => number): Placement[] {
  const placed: Placement[] = [];
  while (placed.length < FLEET.length) {
    const candidate: Placement = { start: Math.floor(random() * SIZE * SIZE), dir: random() < 0.5 ? 'h' : 'v' };
    if (canPlace(placed, placed.length, candidate)) placed.push(candidate);
  }
  return placed;
}

export function createdMatch(host: string): BattleshipMatch {
  return {
    host,
    guest: '',
    currentTurn: 'host',
    status: 'waiting',
    winner: '',
    moveCount: 0,
    hostReady: false,
    guestReady: false,
    hostHits: 0,
    guestHits: 0,
    lastShot: '',
  };
}

export function joinOps(id: string, uid: string): WriteOp[] {
  return [{ type: 'update', path: matchPath(id), data: { guest: uid, status: 'placing' } }];
}

/** Write the fleet and mark the seat ready; the second ready player starts the battle. */
export function readyOps(id: string, m: BattleshipMatch, seat: Seat, placements: Placement[]): WriteOp[] {
  const otherReady = seat === 'host' ? m.guestReady : m.hostReady;
  return [
    { type: 'set', path: `${matchPath(id)}/boards/${m[seat]}`, data: { ...boardDoc(placements) } },
    { type: 'update', path: matchPath(id), data: { [`${seat}Ready`]: true, status: otherReady ? 'playing' : 'placing' } },
  ];
}

export function shotId(seat: Seat, cell: number): string {
  return `${seat === 'host' ? 'h' : 'g'}${String(cell).padStart(2, '0')}`;
}

/** The match after the player on turn fires at `cell` with the given result. */
export function afterShot(m: BattleshipMatch, cell: number, hit: boolean): BattleshipMatch {
  const seat = m.currentTurn;
  const hits = (seat === 'host' ? m.hostHits : m.guestHits) + (hit ? 1 : 0);
  const won = hits === FLEET_CELLS;
  return {
    ...m,
    [`${seat}Hits`]: hits,
    currentTurn: seat === 'host' ? 'guest' : 'host',
    moveCount: m.moveCount + 1,
    lastShot: shotId(seat, cell),
    status: won ? 'won' : 'playing',
    winner: won ? seat : '',
  };
}

export function shotOps(id: string, m: BattleshipMatch, cell: number, hit: boolean): WriteOp[] {
  const seat = m.currentTurn;
  const next = afterShot(m, cell, hit);
  return [
    { type: 'set', path: `${matchPath(id)}/shots/${shotId(seat, cell)}`, data: { by: m[seat], cell, hit } },
    {
      type: 'update',
      path: matchPath(id),
      data: {
        [`${seat}Hits`]: next[`${seat}Hits` as 'hostHits' | 'guestHits'],
        currentTurn: next.currentTurn,
        moveCount: next.moveCount,
        lastShot: next.lastShot,
        status: next.status,
        winner: next.winner,
      },
    },
  ];
}

/** Which ship (index into FLEET) covers `cell`, or -1. */
export function shipAt(board: BoardDoc, cell: number): number {
  let offset = 0;
  for (let i = 0; i < FLEET.length; i++) {
    if (board.cells.slice(offset, offset + FLEET[i]).includes(cell)) return i;
    offset += FLEET[i];
  }
  return -1;
}
