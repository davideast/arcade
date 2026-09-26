import type { GameDefinition, Seat } from '@games/turn-net/types';
import { otherSeat } from '@games/turn-net/types';
import type { MatchDoc } from '@games/turn-net/transitions';
import { RACK, simulate, type Shot, type ShotResult } from './physics.ts';

/**
 * Eight-ball on the match document. The Security Rules check turn order, that
 * pocketed balls stay pocketed, groups, and who wins; they can't check the
 * physics, so each document also carries the table before the shot and the
 * shot itself, and every client replays the shot to check the result
 * (`verifyShot`).
 *
 * Simplifications: the table stays open until a shot pockets balls of one
 * group only; a scratch returns the cue ball to the head string with no ball
 * in hand; and pocketing the 8 ends the game, won only by a player who
 * pocketed their whole group on earlier shots and didn't scratch.
 */

export const COLLECTION = 'pool';

export type Group = '' | 'solids' | 'stripes';

export const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
export const STRIPES = [9, 10, 11, 12, 13, 14, 15];

export interface PoolFields {
  /** Ball n's x and y, in hundredths of a pixel, at indexes 2n and 2n + 1; -1 when pocketed. */
  balls: number[];
  /** Object balls pocketed, in the order they went down. */
  potted: number[];
  prevBalls: number[];
  prevPotted: number[];
  shot: Shot;
  scratch: boolean;
  /** The host's group; the guest has the other one. */
  hostGroup: Group;
}

export type PoolDoc = MatchDoc & PoolFields;

export function initialFields(): PoolFields {
  return {
    balls: [...RACK],
    potted: [],
    prevBalls: [...RACK],
    prevPotted: [],
    shot: { dx: 0, dy: 0, power: 0 },
    scratch: false,
    hostGroup: '',
  };
}

export function groupOf(seat: Seat, hostGroup: Group): Group {
  if (seat === 'host' || hostGroup === '') return hostGroup;
  return hostGroup === 'solids' ? 'stripes' : 'solids';
}

export function groupBalls(group: Group): number[] {
  return group === 'solids' ? SOLIDS : group === 'stripes' ? STRIPES : [];
}

/** Fields a shot's update writes. */
export type ShotUpdate = Pick<PoolDoc, 'balls' | 'potted' | 'prevBalls' | 'prevPotted' | 'shot' | 'scratch' | 'hostGroup'
  | 'currentTurn' | 'moveCount' | 'status' | 'winner'>;

/** The update for a shot with the given physical result. */
export function shotUpdate(doc: PoolDoc, shot: Shot, result: Pick<ShotResult, 'balls' | 'newlyPotted' | 'scratch'>): ShotUpdate {
  const seat = doc.currentTurn;
  const newly = result.newlyPotted;
  let hostGroup = doc.hostGroup;
  if (hostGroup === '' && !result.scratch && newly.length > 0) {
    const claimed: Group = newly.every((n) => SOLIDS.includes(n)) ? 'solids' : newly.every((n) => STRIPES.includes(n)) ? 'stripes' : '';
    if (claimed !== '') hostGroup = seat === 'host' ? claimed : groupOf('guest', claimed);
  }
  const mine = groupOf(seat, hostGroup);
  const eight = newly.includes(8);
  const keep = !result.scratch && !eight && newly.some((n) => groupBalls(mine).includes(n));
  const cleared = mine !== '' && groupBalls(mine).every((n) => doc.potted.includes(n));
  return {
    balls: result.balls,
    potted: [...doc.potted, ...newly],
    prevBalls: doc.balls,
    prevPotted: doc.potted,
    shot,
    scratch: result.scratch,
    hostGroup,
    currentTurn: keep ? seat : otherSeat(seat),
    moveCount: doc.moveCount + 1,
    status: eight ? 'won' : 'playing',
    winner: eight ? (cleared && !result.scratch ? seat : otherSeat(seat)) : '',
  };
}

/** Play `shot` from the stored table. */
export function takeShot(doc: PoolDoc, shot: Shot): { update: ShotUpdate; result: ShotResult } {
  const result = simulate(doc.balls, doc.potted, shot);
  return { update: shotUpdate(doc, shot, result), result };
}

/**
 * Whether the stored result is what the stored shot produces. The rules can't
 * check physics, so a forged table passes them; this replay catches it.
 */
export function verifyShot(doc: PoolDoc): { ok: boolean; result: ShotResult | null } {
  if (doc.moveCount === 0) return { ok: true, result: null };
  const result = simulate(doc.prevBalls, doc.prevPotted, doc.shot);
  const ok = sameList(result.balls, doc.balls)
    && sameList([...doc.prevPotted, ...result.newlyPotted], doc.potted)
    && result.scratch === doc.scratch;
  return { ok, result };
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Lobby definition for the shared turn-net create and join. */
export const pool: GameDefinition<PoolFields, Shot> = {
  id: COLLECTION,
  title: 'Pool',
  logic: {
    initial: initialFields,
    legalMoves: () => [],
    apply: (state) => state,
    outcome: () => ({ status: 'playing' }),
  },
  toFields: (state) => ({ ...state }),
  fromFields: (data) => data as unknown as PoolFields,
};
