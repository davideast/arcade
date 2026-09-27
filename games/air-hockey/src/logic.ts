/**
 * Air hockey's documents and write lists, shared by the client and the
 * rules tests.
 *
 * The lobby and the result live in Firestore, in `airhockey/{matchId}`,
 * through the shared turn-net create, join, cancel and resign. The match
 * document keeps the turn-game fields (`currentTurn` stays 'host' and
 * `moveCount` 0) plus `score` and `endedBy`: '' while the match is open,
 * 'goals' when the host records a side reaching WIN_SCORE, 'forfeit' when a
 * player records that the other left.
 *
 * Live play lives in the Realtime Database under
 * `airhockey/{matchId}/{hostUid}` (livePath). The host's uid is in the
 * path, and the rules require the host to be the writer that creates it, so
 * no one else can take the path a match's players use. Under it:
 *
 *   meta          { guest, status, winner }  the host creates it once
 *   puck          { x, y, vx, vy, t }        the host, each frame (t: tick)
 *   hostMallet    { x, y }                   the host, each frame
 *   seenGuest     { x, y }                   the host: the guest's mallet as simulated
 *   guestMallet   { x, y }                   the guest: its own mallet
 *   score         { host, guest }            the host, on each goal
 *   presence      { host, guest }            each player its own; false on disconnect
 *
 * `meta.status` mirrors the Firestore match into the Realtime Database,
 * whose rules can't read Firestore: the host creates meta as 'playing' when
 * the Firestore match starts, and live writes are allowed only while it is
 * 'playing'. It then ends once: 'over' (the host, with a side at WIN_SCORE),
 * 'forfeit' (a player, while the other's presence is false) or 'resigned'.
 */
import type { GameDefinition, Seat } from '@games/turn-net/types';
import type { MatchDoc } from '@games/turn-net/transitions';
import { round2, winner, type Puck, type Score, type Side, type Vec, type World } from './physics.ts';

export const COLLECTION = 'airhockey';

export type EndedBy = '' | 'goals' | 'forfeit';

export interface AirHockeyFields {
  score: Score;
  endedBy: EndedBy;
}

export type AirHockeyDoc = MatchDoc & AirHockeyFields;

export type WriteOp =
  | { type: 'set'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> };

export const matchPath = (id: string) => `${COLLECTION}/${id}`;

export const airHockey: GameDefinition<AirHockeyFields, null> = {
  id: COLLECTION,
  title: 'Air Hockey',
  logic: {
    initial: () => ({ score: { host: 0, guest: 0 }, endedBy: '' }),
    legalMoves: () => [],
    apply: (state) => state,
    outcome: () => ({ status: 'playing' }),
  },
  toFields: (state) => ({ ...state }),
  fromFields: (data) => data as unknown as AirHockeyFields,
};

/** The host records a match won on goals, with the final score. */
export function finishOps(id: string, score: Score): WriteOp[] {
  const won = winner(score);
  if (!won) throw new Error('No side has won yet.');
  return [{ type: 'update', path: matchPath(id), data: { status: 'won', winner: won, score, endedBy: 'goals' } }];
}

/** `seat` records that the other player left, with the score when they did. */
export function forfeitOps(id: string, seat: Seat, score: Score): WriteOp[] {
  return [{ type: 'update', path: matchPath(id), data: { status: 'won', winner: seat, score, endedBy: 'forfeit' } }];
}

// ─── Realtime Database ──────────────────────────────────────────────

export type LiveStatus = 'playing' | 'over' | 'forfeit' | 'resigned';

export interface LiveMeta {
  guest: string;
  status: LiveStatus;
  winner: '' | Side;
}

export interface LiveFrame {
  puck: Puck & { t: number };
  hostMallet: Vec;
  seenGuest: Vec;
}

/** The live match as stored; any part may be missing before the host starts it. */
export interface LiveMatch extends Partial<LiveFrame> {
  meta?: LiveMeta;
  guestMallet?: Vec;
  score?: Score;
  presence?: Partial<Record<Side, boolean>>;
}

/** A Realtime Database write: `set` replaces the value at `path`; `update` writes each relative path in `data` atomically. */
export type LiveOp =
  | { type: 'set'; path: string; value: unknown }
  | { type: 'update'; path: string; value: Record<string, unknown> };

export const livePath = (id: string, hostUid: string) => `${COLLECTION}/${id}/${hostUid}`;

const point = (p: Vec): Vec => ({ x: round2(p.x), y: round2(p.y) });

/** The frame the host writes for `world`. */
export function frameOf(world: World): LiveFrame {
  const { puck } = world;
  return {
    // Velocities round toward zero, so a puck at top speed never reads faster.
    puck: { x: round2(puck.x), y: round2(puck.y), vx: Math.trunc(puck.vx * 100) / 100, vy: Math.trunc(puck.vy * 100) / 100, t: world.tick },
    hostMallet: point(world.host),
    seenGuest: point(world.guest),
  };
}

/** The host opens the live match for `guestUid`. */
export function startMetaOp(id: string, hostUid: string, guestUid: string): LiveOp {
  return { type: 'set', path: `${livePath(id, hostUid)}/meta`, value: { guest: guestUid, status: 'playing', winner: '' } satisfies LiveMeta };
}

/** The host's first frame, with the score at 0 to 0. */
export function startLiveOp(id: string, hostUid: string, world: World): LiveOp {
  return { type: 'update', path: livePath(id, hostUid), value: { ...frameOf(world), score: { host: 0, guest: 0 } } };
}

/**
 * A frame from the host. A frame after a goal carries the new score; a
 * frame that ends the match also closes it, naming the winner.
 */
export function frameOp(id: string, hostUid: string, world: World, scored: boolean): LiveOp {
  const value: Record<string, unknown> = { ...frameOf(world) };
  if (scored) value.score = { ...world.score };
  const won = winner(world.score);
  if (scored && won) {
    value['meta/status'] = 'over';
    value['meta/winner'] = won;
  }
  return { type: 'update', path: livePath(id, hostUid), value };
}

/** The guest's own mallet. */
export function malletOp(id: string, hostUid: string, p: Vec): LiveOp {
  return { type: 'set', path: `${livePath(id, hostUid)}/guestMallet`, value: point(p) };
}

export function presencePath(id: string, hostUid: string, side: Side): string {
  return `${livePath(id, hostUid)}/presence/${side}`;
}

export function presenceOp(id: string, hostUid: string, side: Side, present: boolean): LiveOp {
  return { type: 'set', path: presencePath(id, hostUid, side), value: present };
}

/** `side` claims the match because the other player's presence is gone. */
export function forfeitMetaOp(id: string, hostUid: string, side: Side): LiveOp {
  return { type: 'update', path: `${livePath(id, hostUid)}/meta`, value: { status: 'forfeit', winner: side } };
}

/** `side` resigns the live match. */
export function resignMetaOp(id: string, hostUid: string, side: Side): LiveOp {
  return { type: 'update', path: `${livePath(id, hostUid)}/meta`, value: { status: 'resigned', winner: side === 'host' ? 'guest' : 'host' } };
}

/**
 * Whether the Firestore result agrees with the live match, which the
 * Realtime Database rules checked: a match won on goals has the live final
 * score, and a forfeit has a live forfeit for the same winner. Firestore
 * rules can't read the Realtime Database, so every client checks this and
 * flags a result that disagrees.
 */
export function resultMatchesLive(doc: AirHockeyDoc, live: LiveMatch | null): boolean {
  if (doc.endedBy === '') return true;
  const meta = live?.meta;
  if (!meta) return false;
  if (doc.endedBy === 'forfeit') return meta.status === 'forfeit' && meta.winner === doc.winner;
  return meta.status === 'over' && meta.winner === doc.winner
    && live?.score?.host === doc.score.host && live?.score?.guest === doc.score.guest;
}
