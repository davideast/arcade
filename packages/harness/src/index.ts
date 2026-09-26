/**
 * Rules test harness for two-player turn games.
 *
 * Plays seeded random games with the game's own logic and turns every
 * transition into Security Rules cases: each real transition must be allowed,
 * and each cheat derived from it must be denied. The cases run in Pyric's
 * rules simulator against the resolved ruleset.
 */
import { firestoreRules, serverTimestamp, timestamp, type CaseResult, type FirestoreCase } from 'pyric/rules';
import type { GameDefinition, Seat } from '@games/turn-net/types';
import { otherSeat } from '@games/turn-net/types';
import {
  createdMatch,
  joinedMatch,
  movedMatch,
  resignedMatch,
  type MatchDoc,
} from '@games/turn-net/transitions';

export const HOST = { uid: 'host-uid' };
export const GUEST = { uid: 'guest-uid' };
export const STRANGER = { uid: 'stranger-uid' };

const CREATED_AT = '2026-09-25T12:00:00.000Z';
const NOW = '2026-09-25T12:00:05.000Z';

/** A cheat turns one real move into a forged one that the rules must deny. */
export interface Cheat {
  name: string;
  /** Returns the forged after-document, or null when the cheat doesn't apply to this move. */
  forge(before: MatchDoc, after: MatchDoc): MatchDoc | null;
  /** Who sends the forged write. Defaults to the player on turn. */
  auth?: (before: MatchDoc) => { uid: string };
}

export interface HarnessOptions {
  games: number;
  seed: number;
  /** Cheats specific to this game, applied to every move alongside the shared ones. */
  cheats?: Cheat[];
}

export interface HarnessReport {
  cases: number;
  failures: CaseResult[];
}

/** Deterministic PRNG so a failing seed reproduces. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uidOf(seat: Seat): string {
  return seat === 'host' ? HOST.uid : GUEST.uid;
}

/** Stored documents carry the creation time the create rule pinned. */
function stored(doc: MatchDoc): Record<string, unknown> {
  return { createdAt: timestamp(CREATED_AT), ...doc };
}

function update(description: string, expectation: 'ALLOW' | 'DENY', auth: { uid: string }, before: MatchDoc, after: MatchDoc): FirestoreCase {
  return {
    description,
    expectation,
    method: 'update',
    path: 'match/m1',
    auth,
    resource: stored(before),
    data: stored(after),
    requestTime: NOW,
  };
}

/** Cheats every grid-placement game must deny. The document holds a `board` map and `lastMove`. */
export const placementCheats: Cheat[] = [
  {
    name: 'the player not on turn moves',
    forge: (_b, after) => after,
    auth: (before) => ({ uid: uidOf(otherSeat(before.currentTurn)) }),
  },
  {
    name: 'a non-participant moves',
    forge: (_b, after) => after,
    auth: () => STRANGER,
  },
  {
    name: 'a second empty cell is marked in the same write',
    forge(before, after) {
      const board = after.board as Record<string, string>;
      const extra = Object.keys(board).find((k) => board[k] === '');
      if (!extra) return null;
      return { ...after, board: { ...board, [extra]: before.currentTurn } };
    },
  },
  {
    name: "the move takes an opponent's cell instead of an empty one",
    forge(before, after) {
      const board = before.board as Record<string, string>;
      const theirs = Object.keys(board).find((k) => board[k] === otherSeat(before.currentTurn));
      if (!theirs) return null;
      return { ...after, board: { ...board, [theirs]: before.currentTurn }, lastMove: theirs, status: 'playing', winner: '' };
    },
  },
  {
    name: "the move places the opponent's mark",
    forge(before, after) {
      const cell = after.lastMove as string;
      const board = after.board as Record<string, string>;
      return { ...after, board: { ...board, [cell]: otherSeat(before.currentTurn) }, status: 'playing', winner: '' };
    },
  },
  {
    name: "an opponent's cell is overwritten in the same write",
    forge(before, after) {
      const board = after.board as Record<string, string>;
      const theirs = Object.keys(board).find((k) => board[k] === otherSeat(before.currentTurn));
      if (!theirs) return null;
      return { ...after, board: { ...board, [theirs]: before.currentTurn } };
    },
  },
  {
    name: 'the move claims a win it did not make',
    forge: (before, after) =>
      after.status === 'won' ? null : { ...after, status: 'won', winner: before.currentTurn },
  },
  {
    // A winning move reported as a draw is allowed: like reporting it as
    // 'playing', it only gives up the mover's own win.
    name: 'the move claims a draw early',
    forge: (_b, after) => (after.status === 'playing' ? { ...after, status: 'draw', winner: '' } : null),
  },
  {
    name: 'the move skips a move number',
    forge: (_b, after) => ({ ...after, moveCount: after.moveCount + 1 }),
  },
  {
    name: 'the move swaps in a new guest',
    forge: (_b, after) => ({ ...after, guest: STRANGER.uid }),
  },
  {
    name: 'the move adds a field',
    forge: (_b, after) => ({ ...after, score: 100 }),
  },
  {
    name: 'the move rewrites the creation time',
    forge: (_b, after) => ({ ...after, createdAt: timestamp(NOW) }),
  },
  {
    name: 'the move keeps the turn',
    forge: (before, after) => ({ ...after, currentTurn: before.currentTurn }),
  },
];

/** The created document's board with its first cell already marked by the host. */
function prefilled(created: MatchDoc): Partial<MatchDoc> {
  const board = created.board as Record<string, string> | undefined;
  if (!board) return {};
  const [first] = Object.keys(board);
  return { board: { ...board, [first]: 'host' } };
}

/** The created document's board with one of its cells removed. */
function missingCell(created: MatchDoc): Partial<MatchDoc> {
  const board = created.board as Record<string, string> | undefined;
  if (!board) return {};
  const { [Object.keys(board).at(-1)!]: _dropped, ...rest } = board;
  return { board: rest };
}

/** The created document's board with one cell renamed to a name off the grid. */
function offGridCell(created: MatchDoc): Partial<MatchDoc> {
  const board = created.board as Record<string, string> | undefined;
  if (!board) return {};
  const { [Object.keys(board).at(-1)!]: _dropped, ...rest } = board;
  return { board: { ...rest, offGrid: '' } };
}

/** Build every case for seeded random games of `def`. */
export function buildCases<S, M>(def: GameDefinition<S, M>, options: HarnessOptions): FirestoreCase[] {
  const random = mulberry32(options.seed);
  const cheats = [...placementCheats, ...(options.cheats ?? [])];
  const created = createdMatch(def, HOST.uid);
  const joined = joinedMatch(created, GUEST.uid);
  const cases: FirestoreCase[] = [
    {
      description: 'create: an empty match',
      expectation: 'ALLOW',
      method: 'create',
      path: 'match/m1',
      auth: HOST,
      data: { ...created, createdAt: serverTimestamp() },
      requestTime: NOW,
    },
    {
      description: 'create: a match that names someone else as host',
      expectation: 'DENY',
      method: 'create',
      path: 'match/m1',
      auth: GUEST,
      data: { ...created, createdAt: serverTimestamp() },
      requestTime: NOW,
    },
    {
      description: 'create: a match with a mark already on the board',
      expectation: 'DENY',
      method: 'create',
      path: 'match/m1',
      auth: HOST,
      data: { ...created, ...prefilled(created), createdAt: serverTimestamp() },
      requestTime: NOW,
    },
    ...(created.board ? [
      {
        description: 'create: a match with a board missing a cell',
        expectation: 'DENY' as const,
        method: 'create' as const,
        path: 'match/m1',
        auth: HOST,
        data: { ...created, ...missingCell(created), createdAt: serverTimestamp() },
        requestTime: NOW,
      },
      {
        description: 'create: a match with a board cell off the grid',
        expectation: 'DENY' as const,
        method: 'create' as const,
        path: 'match/m1',
        auth: HOST,
        data: { ...created, ...offGridCell(created), createdAt: serverTimestamp() },
        requestTime: NOW,
      },
    ] : []),
    {
      description: 'create: a match with an extra field',
      expectation: 'DENY',
      method: 'create',
      path: 'match/m1',
      auth: HOST,
      data: { ...created, score: 100, createdAt: serverTimestamp() },
      requestTime: NOW,
    },
    {
      description: 'create: a match with a client-chosen creation time',
      expectation: 'DENY',
      method: 'create',
      path: 'match/m1',
      auth: HOST,
      data: { ...created, createdAt: timestamp(CREATED_AT) },
      requestTime: NOW,
    },
    update('join: the guest takes the open seat', 'ALLOW', GUEST, created, joined),
    update('join: the host joins their own match', 'DENY', HOST, created, { ...joined, guest: HOST.uid }),
    update('join: the guest also changes the turn', 'DENY', GUEST, created, { ...joined, currentTurn: 'guest' }),
    update('resign: the guest resigns', 'ALLOW', GUEST, joined, resignedMatch(joined, 'guest')),
    update('resign: the guest resigns and names themself winner', 'DENY', GUEST, joined, { ...resignedMatch(joined, 'guest'), winner: 'guest' }),
    update('resign: a non-participant resigns for the host', 'DENY', STRANGER, joined, resignedMatch(joined, 'host')),
    update('resign: a non-participant resigns for the guest', 'DENY', STRANGER, joined, resignedMatch(joined, 'guest')),
    update('resign: the guest resigns and also writes the board', 'DENY', GUEST, joined, { ...resignedMatch(joined, 'guest'), ...prefilled(joined) }),
  ];

  for (let game = 0; game < options.games; game++) {
    let doc = joined;
    while (doc.status === 'playing') {
      const seat = doc.currentTurn;
      const moves = def.logic.legalMoves(def.fromFields(doc), seat);
      const move = moves[Math.floor(random() * moves.length)];
      const next = movedMatch(def, doc, move);
      const label = `game ${game} move ${doc.moveCount + 1} (${next.status})`;
      cases.push(update(`${label}: the real move`, 'ALLOW', { uid: uidOf(seat) }, doc, next));
      for (const cheat of cheats) {
        const forged = cheat.forge(doc, next);
        if (forged === null) continue;
        const auth = cheat.auth?.(doc) ?? { uid: uidOf(seat) };
        cases.push(update(`${label}: ${cheat.name}`, 'DENY', auth, doc, forged));
      }
      doc = next;
    }
    // Once the game is over, no further move is accepted.
    const seat = doc.currentTurn;
    const leftover = def.logic.legalMoves(def.fromFields(doc), seat);
    if (leftover.length > 0) {
      const after = { ...movedMatch(def, { ...doc, status: 'playing' }, leftover[0]), status: 'playing' as const, winner: '' as const };
      cases.push(update(`game ${game}: a move after the game ended`, 'DENY', { uid: uidOf(seat) }, doc, after));
    }
  }
  return cases;
}

/** Run the cases against a resolved ruleset, rooted at `collection`. */
export function runHarness<S, M>(
  def: GameDefinition<S, M>,
  rulesSource: string,
  options: HarnessOptions,
): HarnessReport {
  const cases = buildCases(def, options).map((c) => ({ ...c, path: c.path.replace(/^match\//, `${def.id}/`) }));
  const summary = firestoreRules(rulesSource).simulate(cases);
  return { cases: cases.length, failures: summary.cases.filter((r) => !r.passed) };
}
