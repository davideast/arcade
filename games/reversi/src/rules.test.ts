/**
 * Reversi Security Rules against Pyric's sandbox. Seeded games run through
 * the same write lists the browser applies (moveOps, passOps), each write as
 * the acting player's identity. Every real move and pass must be allowed;
 * before each one, a set of cheats derived from it must be denied and leave
 * the match unchanged. Seeded late-game positions reach passes, a win, a
 * draw, and a full board.
 *
 * The rules can't tell whether a player who passes had a move, or whether a
 * game marked over has moves left: a forged pass and a false end are
 * allowed, and the replay (`verifyMove`) must flag them.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { mulberry32 } from '@games/harness';
import { createdMatch, joinedMatch } from '@games/turn-net/transitions';
import {
  DIRECTIONS,
  applyMove,
  counts,
  fileOf,
  flipsIn,
  legalMoves,
  next,
  other,
  rankOf,
  reach,
  squareAt,
  squareName,
  squareOfName,
  type Board,
} from './reversi.ts';
import {
  fromMap,
  matchPath,
  moveOps,
  moveUpdate,
  passOps,
  passUpdate,
  positionOf,
  reversi,
  sideOfSeat,
  squareKey,
  toMap,
  verifyMove,
  type BoardMap,
  type ReversiDoc,
  type WriteOp,
} from './logic.ts';

const rules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();

type Db = ReturnType<typeof getFirestore>;
type Data = Record<string, unknown>;
type Seat = 'host' | 'guest';

async function apply(db: Db, ops: WriteOp[]): Promise<void> {
  const batch = db.batch();
  for (const op of ops) {
    const ref = db.doc(op.path);
    if (op.type === 'set') batch.set(ref, op.data);
    else batch.update(ref, op.data);
  }
  await batch.commit();
}

/** The single match update of `ops` with `patch` merged into its data. */
function patched(ops: WriteOp[], patch: Data): WriteOp[] {
  return ops.map((op) => ({ ...op, data: { ...op.data, ...patch } }));
}

class Match {
  readonly sandbox = initializeSandbox();
  readonly failures: string[] = [];
  readonly dbFor: Record<Seat, Db>;
  readonly stranger: Db;
  readonly path: string;

  constructor(readonly id: string) {
    getFirestore(this.sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(rules);
    this.dbFor = {
      host: getFirestore(this.sandbox.withAuth({ uid: 'host-uid' })),
      guest: getFirestore(this.sandbox.withAuth({ uid: 'guest-uid' })),
    };
    this.stranger = getFirestore(this.sandbox.withAuth({ uid: 'stranger-uid' }));
    this.path = matchPath(id);
  }

  stored(): ReversiDoc {
    return this.sandbox.admin.getDocument(this.path) as ReversiDoc;
  }

  seed(doc: Data): void {
    this.sandbox.admin.setDocument(this.path, doc);
  }

  async denied(label: string, db: Db, ops: WriteOp[]): Promise<void> {
    const before = JSON.stringify(this.stored());
    try {
      await apply(db, ops);
      this.failures.push(`allowed: ${label}`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'permission-denied') this.failures.push(`${label}: failed with ${code} ${(e as Error).message}`);
    }
    if (JSON.stringify(this.stored()) !== before) this.failures.push(`changed state: ${label}`);
  }

  async allowed(label: string, db: Db, ops: WriteOp[]): Promise<boolean> {
    try {
      await apply(db, ops);
      return true;
    } catch (e) {
      this.failures.push(`denied: ${label} (${(e as Error).message})`);
      return false;
    }
  }

  async createAndJoin(withCheats: boolean): Promise<void> {
    const fresh = { ...createdMatch(reversi, 'host-uid'), createdAt: FieldValue.serverTimestamp() } as Data;
    const board = fresh.board as BoardMap;
    const create = (data: Data): WriteOp[] => [{ type: 'set', path: this.path, data }];
    if (withCheats) {
      const host = this.dbFor.host;
      await this.denied('create with a disc moved', host, create({ ...fresh, board: { ...board, '44': '', '34': 'l' } }));
      await this.denied('create with an extra disc', host, create({ ...fresh, board: { ...board, '11': 'd' }, counts: { d: 3, l: 2 } }));
      await this.denied('create with a square missing', host, create({ ...fresh, board: Object.fromEntries(Object.entries(board).filter(([k]) => k !== '11')) }));
      await this.denied('create with light to move', host, create({ ...fresh, currentTurn: 'guest' }));
      await this.denied('create with a last move', host, create({ ...fresh, lastMove: { at: '34', runs: [0, 0, 1, 0, 0, 0, 0, 0] } }));
      await this.denied('create with a move already made', host, create({ ...fresh, moveCount: 1 }));
      await this.denied('create with dark ahead', host, create({ ...fresh, counts: { d: 3, l: 2 } }));
      await this.denied('create with an extra field', host, create({ ...fresh, timer: 60 }));
      await this.denied('create with a client clock', host, create({ ...fresh, createdAt: new Date(0) }));
      await this.denied('create with a winner', host, create({ ...fresh, winner: 'host' }));
      await this.denied('create with a previous position', host, create({ ...fresh, prevBoard: { ...board, '34': 'd', '44': 'd' } }));
      await this.denied('create for someone else', host, create({ ...fresh, host: 'guest-uid' }));
      await this.denied('create by a stranger', this.stranger, create(fresh));
    }
    if (!(await this.allowed('create', this.dbFor.host, create(fresh)))) return;
    const joined = joinedMatch(this.stored(), 'guest-uid');
    const join = (data: Data): WriteOp[] => [{ type: 'update', path: this.path, data }];
    if (withCheats) {
      await this.denied('dark joins their own match', this.dbFor.host, join({ guest: 'host-uid', status: 'playing' }));
      await this.denied('join and take the first move', this.dbFor.guest, join({ guest: joined.guest, status: joined.status, currentTurn: 'guest' }));
      await this.denied('join and add a disc', this.dbFor.guest, join({ guest: joined.guest, status: joined.status, board: { ...board, '11': 'l' } }));
    }
    await this.allowed('join', this.dbFor.guest, join({ guest: joined.guest, status: joined.status }));
    if (withCheats) await this.denied('join a full match', this.stranger, join({ guest: 'stranger-uid' }));
  }
}

const otherSeat = (seat: Seat): Seat => (seat === 'host' ? 'guest' : 'host');

/** The squares at distance 1..n from `sq` in direction `dir`. */
function ray(sq: number, dir: number, n: number): number[] {
  const [df, dr] = DIRECTIONS[dir];
  return Array.from({ length: n }, (_, k) => squareAt(fileOf(sq) + (k + 1) * df, rankOf(sq) + (k + 1) * dr));
}

/** A move's write with the board replaced by `board`, and counts that agree with it. */
function forgedBoard(ops: WriteOp[], board: Board, extra: Data = {}): WriteOp[] {
  return patched(ops, { board: toMap(board), counts: counts(board), ...extra });
}

/**
 * Cheats derived from the real move at `sq`, each denied with nothing
 * changed. Forged boards come with counts computed from them, so the board
 * checks are what deny them.
 */
async function moveCheats(m: Match, doc: ReversiDoc, sq: number): Promise<void> {
  const seat = doc.currentTurn;
  const me = sideOfSeat(seat);
  const op = other(me);
  const db = m.dbFor[seat];
  const real = moveOps(m.id, doc, sq);
  const up = moveUpdate(doc, sq);
  const before = fromMap(doc.board);
  const pos = { board: before, turn: me };
  const placed = applyMove(pos, sq);
  const key = squareKey(sq);

  await m.denied('move out of turn', m.dbFor[otherSeat(seat)], real);
  await m.denied('a stranger moves', m.stranger, real);

  for (let dir = 0; dir < 8; dir++) {
    const n = flipsIn(before, sq, me, dir);
    const r = reach(before, sq, me, dir);
    if (n > 0) {
      // The run left unflipped, with its reach stored honestly, then claimed as 0.
      const missed = placed.board.slice();
      for (const s of ray(sq, dir, n)) missed[s] = op;
      await m.denied(`miss the flip in direction ${dir}`, db, forgedBoard(real, missed));
      const runs = placed.runs.slice();
      runs[dir] = 0;
      await m.denied(`miss the flip in direction ${dir} and store no reach`, db, forgedBoard(real, missed, { lastMove: { at: key, runs } }));
      // Only the first disc of a longer run flipped.
      if (n > 1) {
        const partial = placed.board.slice();
        for (const s of ray(sq, dir, n).slice(1)) partial[s] = op;
        await m.denied(`flip part of the run in direction ${dir}`, db, forgedBoard(real, partial));
      }
      // The run emptied instead of flipped.
      const emptied = placed.board.slice();
      emptied[ray(sq, dir, 1)[0]] = '';
      await m.denied(`empty a flipped disc in direction ${dir}`, db, forgedBoard(real, emptied));
      // Reach stored one short: the square past it is still the opponent's, or the end is claimed early.
      runs[dir] = n - 1;
      const short = placed.board.slice();
      short[ray(sq, dir, n)[n - 1]] = op;
      await m.denied(`store the reach in direction ${dir} one short`, db, forgedBoard(real, short, { lastMove: { at: key, runs } }));
    } else if (r > 0) {
      // An unbracketed run flipped, stored honestly and stored as bracketed.
      const extra = placed.board.slice();
      for (const s of ray(sq, dir, r)) extra[s] = me;
      await m.denied(`flip an unbracketed run in direction ${dir}`, db, forgedBoard(real, extra));
      const runs = placed.runs.slice();
      runs[dir] = r + 1;
      const past = ray(sq, dir, r + 1)[r];
      if (past >= 0 && before[past] === '') {
        // Claim one square past the run, and fill it with the mover's disc.
        const filled = extra.slice();
        filled[past] = me;
        await m.denied(`reach past the run in direction ${dir} onto an empty square`, db, forgedBoard(real, filled, { lastMove: { at: key, runs } }));
      }
    } else {
      // Nothing to flip: claim the neighbor as flipped.
      const near = ray(sq, dir, 1)[0];
      if (near >= 0) {
        const runs = placed.runs.slice();
        runs[dir] = 1;
        const claimed = placed.board.slice();
        claimed[near] = me;
        await m.denied(`claim the ${before[near] === me ? "mover's own" : 'empty'} neighbor in direction ${dir}`, db, forgedBoard(real, claimed, { lastMove: { at: key, runs } }));
      }
    }
  }

  const flipped = new Set(placed.flipped);
  const bystander = before.findIndex((c, s) => c === op && !flipped.has(s));
  if (bystander >= 0) {
    const extra = placed.board.slice();
    extra[bystander] = me;
    await m.denied('flip an extra opponent disc', db, forgedBoard(real, extra));
    await m.denied('flip an extra disc and keep the counts', db, patched(real, { board: toMap(extra) }));
  }
  const own = before.findIndex((c) => c === me);
  if (own >= 0) {
    const turned = placed.board.slice();
    turned[own] = op;
    await m.denied("flip one of the mover's own discs", db, forgedBoard(real, turned));
    const removed = placed.board.slice();
    removed[own] = '';
    await m.denied("remove one of the mover's own discs", db, forgedBoard(real, removed));
  }
  const emptySquare = before.findIndex((c, s) => c === '' && s !== sq);
  if (emptySquare >= 0) {
    const added = placed.board.slice();
    added[emptySquare] = me;
    await m.denied('place a second disc', db, forgedBoard(real, added));
  }

  // A move on an occupied square: flips computed as if it were empty.
  for (const occupied of [before.findIndex((c) => c === op), before.findIndex((c) => c === me)]) {
    if (occupied < 0) continue;
    const emptied = before.slice();
    emptied[occupied] = '';
    const onTop = applyMove({ board: emptied, turn: me }, occupied);
    const kind = before[occupied] === me ? 'own' : "opponent's";
    await m.denied(`play on an ${kind} disc`, db, forgedBoard(real, onTop.board, { lastMove: { at: squareKey(occupied), runs: onTop.runs } }));
  }

  // A move that flips nothing: an empty square with no bracketed run.
  const idle = before.findIndex((c, s) => c === '' && !legalMoves(pos).includes(s));
  if (idle >= 0) {
    const quiet = before.slice();
    quiet[idle] = me;
    await m.denied('play a square that flips nothing', db, forgedBoard(real, quiet, { lastMove: { at: squareKey(idle), runs: applyMove(pos, idle).runs } }));
  }
  // The stored square is not where the disc went.
  const elsewhere = legalMoves(pos).find((s) => s !== sq);
  if (elsewhere !== undefined) {
    await m.denied('name a different square than the one played', db, patched(real, { lastMove: { at: squareKey(elsewhere), runs: placed.runs } }));
  }
  await m.denied("place the opponent's disc", db, patched(real, { board: { ...up.board, [key]: op } }));
  await m.denied('a move with no square', db, patched(real, { lastMove: { at: 'x', runs: placed.runs } }));
  await m.denied('store nine directions', db, patched(real, { lastMove: { at: key, runs: [...placed.runs, 0] } }));
  const fractional = placed.runs.findIndex((n, dir) => n > 0 && flipsIn(before, sq, me, dir) > 0);
  if (fractional >= 0) {
    // A reach of n + 0.5 skips the square past the run.
    const runs = placed.runs.slice();
    runs[fractional] += 0.5;
    const missed = placed.board.slice();
    for (const s of ray(sq, fractional, placed.runs[fractional])) missed[s] = op;
    await m.denied('store a fractional reach and skip the flip', db, forgedBoard(real, missed, { lastMove: { at: key, runs } }));
  }
  await m.denied('add a field to the move', db, patched(real, { lastMove: { ...up.lastMove, note: 'x' } }));
  await m.denied('add a square to the board', db, patched(real, { board: { ...up.board, '99': '' } }));
  await m.denied('rewrite the board before the move', db, patched(real, { prevBoard: up.board }));
  await m.denied('count an extra disc for the mover', db, patched(real, { counts: { ...up.counts, [me]: up.counts[me] + 1 } }));
  await m.denied('count one fewer disc for the opponent', db, patched(real, { counts: { ...up.counts, [op]: up.counts[op] - 1 } }));
  await m.denied('add a side to the counts', db, patched(real, { counts: { ...up.counts, x: 0 } }));
  await m.denied('keep the turn', db, patched(real, { currentTurn: seat }));
  await m.denied('skip a move number', db, patched(real, { moveCount: doc.moveCount + 2 }));
  const c = up.counts;
  const leader: Seat = c.d > c.l ? 'host' : 'guest';
  await m.denied('name the side with fewer discs the winner', db, patched(real, { status: 'won', winner: c.d === c.l ? 'host' : otherSeat(leader) }));
  if (c.d !== c.l) await m.denied('call a draw with unequal counts', db, patched(real, { status: 'draw', winner: '' }));
  if (c.d === c.l) await m.denied('name a winner on equal counts', db, patched(real, { status: 'won', winner: 'host' }));
  if (up.status === 'playing') await m.denied('name a winner while play goes on', db, patched(real, { winner: leader }));
  // Play on with the board full; with squares left, only the replay can tell the game is over.
  if (c.d + c.l === 64) await m.denied('play on with the board full', db, patched(real, { status: 'playing', winner: '' }));
  await m.denied('a draw with a winner', db, patched(real, { status: 'draw', winner: seat }));
  await m.denied('add a field', db, patched(real, { extra: true }));
  await m.denied('replace the opponent', db, patched(real, { [otherSeat(seat)]: 'stranger-uid' }));
  await m.denied('store the move as a pass', db, patched(real, { lastMove: { at: '', runs: [] } }));
}

/** Cheats derived from a real pass. */
async function passCheats(m: Match, doc: ReversiDoc): Promise<void> {
  const seat = doc.currentTurn;
  const db = m.dbFor[seat];
  const real = passOps(m.id, doc);
  const board = doc.board;
  const empty = Object.keys(board).find((k) => board[k] === '')!;
  await m.denied('pass out of turn', m.dbFor[otherSeat(seat)], real);
  await m.denied('a stranger passes', m.stranger, real);
  await m.denied('pass and place a disc', db, patched(real, { board: { ...board, [empty]: sideOfSeat(seat) } }));
  await m.denied('pass and change the counts', db, patched(real, { counts: { ...doc.counts, [sideOfSeat(seat)]: doc.counts[sideOfSeat(seat)] + 1 } }));
  await m.denied('pass and keep the turn', db, patched(real, { currentTurn: seat }));
  await m.denied('pass without a move number', db, patched(real, { moveCount: doc.moveCount }));
  await m.denied('pass and store a reach', db, patched(real, { lastMove: { at: '', runs: [0, 0, 0, 0, 0, 0, 0, 0] } }));
  await m.denied('pass and rewrite the board before it', db, patched(real, { prevBoard: { ...board, [empty]: 'd' } }));
  await m.denied('pass and end the game', db, patched(real, { status: 'won', winner: seat }));
  await m.denied('pass and name a winner', db, patched(real, { winner: seat }));
  await m.denied('pass and add a field', db, patched(real, { extra: true }));
}

/** Play from the stored match to the end or `maxPlies`, with cheats before every write. */
async function play(m: Match, pick: (moves: number[]) => number, maxPlies: number, label: string): Promise<{ passes: number; plies: number }> {
  let passes = 0;
  let plies = 0;
  for (; plies < maxPlies && m.stored().status === 'playing'; plies++) {
    const doc = m.stored();
    const seat = doc.currentTurn;
    const moves = legalMoves(positionOf(doc.board, seat));
    if (moves.length === 0) {
      await passCheats(m, doc);
      if (!(await m.allowed(`${label} ply ${plies + 1} pass`, m.dbFor[seat], passOps(m.id, doc)))) break;
      passes++;
    } else {
      const sq = pick(moves);
      await moveCheats(m, doc, sq);
      if (!(await m.allowed(`${label} ply ${plies + 1} ${squareName(sq)}`, m.dbFor[seat], moveOps(m.id, doc, sq)))) break;
    }
    if (!verifyMove(m.stored())) m.failures.push(`${label} ply ${plies + 1}: replay disagrees with a real write`);
  }
  return { passes, plies };
}

/** A match seeded mid-game at `board` with `seat` to move. */
async function seeded(id: string, board: Board, seat: Seat, moveCount: number): Promise<Match> {
  const m = new Match(id);
  await m.createAndJoin(false);
  const map = toMap(board);
  m.seed({ ...m.stored(), board: map, prevBoard: map, counts: counts(board), currentTurn: seat, moveCount } as unknown as Data);
  return m;
}

interface Line {
  board: Board;
  seat: Seat;
  moveCount: number;
  /** The moves played from there, in order; passes are not listed. */
  moves: number[];
}

/**
 * Random games in pure logic, searched for the first one where `wanted`
 * happens; returns the position `lead` writes before it and the moves that
 * follow to the end of that game.
 */
function findLine(wanted: (doc: ReversiDoc, passed: boolean) => boolean, lead: number): Line {
  for (let seed = 1; seed < 5000; seed++) {
    const random = mulberry32(seed);
    let doc = joinedMatch(createdMatch(reversi, 'host-uid'), 'guest-uid') as ReversiDoc;
    const history: { doc: ReversiDoc; move: number | null }[] = [];
    let hit = -1;
    while (doc.status === 'playing') {
      const moves = legalMoves(positionOf(doc.board, doc.currentTurn));
      const move = moves.length === 0 ? null : moves[Math.floor(random() * moves.length)];
      history.push({ doc, move });
      doc = { ...doc, ...(move === null ? passUpdate(doc) : moveUpdate(doc, move)) } as ReversiDoc;
      if (hit < 0 && wanted(doc, move === null)) hit = history.length - 1;
    }
    if (hit >= 0) {
      const from = Math.max(0, hit - lead);
      const start = history[from].doc;
      const moves = history.slice(from).flatMap((h) => (h.move === null ? [] : [h.move]));
      return { board: fromMap(start.board), seat: start.currentTurn, moveCount: start.moveCount, moves };
    }
  }
  throw new Error('no game found');
}

/** Seed the line's position and play its moves with cheats before every write. */
async function playLine(id: string, line: Line): Promise<{ m: Match; passes: number }> {
  const m = await seeded(id, line.board, line.seat, line.moveCount);
  const picks = line.moves.slice();
  const { passes } = await play(m, (moves) => {
    const sq = picks.shift();
    if (sq === undefined || !moves.includes(sq)) throw new Error(`${id}: the line left the game`);
    return sq;
  }, 80, id);
  return { m, passes };
}

describe('Reversi Security Rules', () => {
  test('two full games: real moves allowed, cheats denied', async () => {
    const failures: string[] = [];
    for (const seed of [1, 2]) {
      const m = new Match(`g${seed}`);
      await m.createAndJoin(seed === 1);
      const random = mulberry32(seed);
      const { plies } = await play(m, (moves) => moves[Math.floor(random() * moves.length)], 80, `game ${seed}`);
      const end = m.stored();
      if (end.status === 'playing') m.failures.push(`game ${seed} did not end in ${plies} plies`);
      await m.denied('a move after the game ended', m.dbFor[end.currentTurn], patched(moveOps(m.id, end, 0), { status: end.status, winner: end.winner }));
      failures.push(...m.failures);
    }
    expect(failures.slice(0, 30)).toEqual([]);
  }, 120_000);

  test('passes and endings from seeded late-game positions', async () => {
    const failures: string[] = [];
    // A game with a pass, played from three writes before it to the end.
    const pass = await playLine('pass', findLine((_, passed) => passed, 3));
    if (pass.passes === 0) failures.push('the pass line reached no pass');
    failures.push(...pass.m.failures);

    // A draw and a win on a full board, from two writes before the end.
    const draw = await playLine('draw', findLine((doc) => doc.status === 'draw', 2));
    if (draw.m.stored().status !== 'draw') failures.push(`the draw line ended ${draw.m.stored().status}`);
    failures.push(...draw.m.failures);
    const full = await playLine('full', findLine((doc) => doc.status === 'won' && doc.counts.d + doc.counts.l === 64, 2));
    if (full.m.stored().status !== 'won') failures.push(`the full-board line ended ${full.m.stored().status}`);
    failures.push(...full.m.failures);

    // A wipeout with squares left: light has no move and passes, then dark takes the last light disc.
    const board: Board = Array(64).fill('');
    board[squareOfName('a1')] = 'd';
    board[squareOfName('b1')] = 'l';
    const wipe = await seeded('wipe', board, 'guest', 30);
    if (next(board, 'l') !== 'pass') wipe.failures.push('the wipeout seed does not start with a pass');
    const { passes } = await play(wipe, (moves) => moves[0], 4, 'wipe');
    const end = wipe.stored();
    if (passes !== 1 || end.status !== 'won' || end.winner !== 'host') wipe.failures.push(`wipeout: ${passes} passes, ended ${end.status} ${end.winner}`);
    await wipe.denied('a pass after the game ended', wipe.dbFor[end.currentTurn], passOps(wipe.id, end));
    await wipe.denied('resign after the game ended', wipe.dbFor.guest, [{ type: 'update', path: wipe.path, data: { status: 'resigned', winner: 'host' } }]);
    failures.push(...wipe.failures);

    expect(failures.slice(0, 30)).toEqual([]);
  }, 120_000);

  test('a forged pass and a false end are allowed by the rules and flagged by the replay', async () => {
    const m = new Match('forged');
    await m.createAndJoin(false);
    // Dark has four moves and passes anyway.
    await m.allowed('dark passes with moves left (rules cannot search)', m.dbFor.host, passOps(m.id, m.stored()));
    if (verifyMove(m.stored())) m.failures.push('replay missed a forged pass');

    const n = new Match('false-end');
    await n.createAndJoin(false);
    const start = n.stored();
    const up = moveUpdate(start, squareOfName('d3'));
    await n.allowed('dark plays d3 and claims the game (rules cannot search)', n.dbFor.host,
      patched(moveOps(n.id, start, squareOfName('d3')), { status: 'won', winner: up.counts.d > up.counts.l ? 'host' : 'guest' }));
    if (verifyMove(n.stored())) n.failures.push('replay missed a false end');

    // The opposite claim: dark takes the last light disc with squares left and plays on.
    const wiped: Board = Array(64).fill('');
    wiped[squareOfName('a1')] = 'd';
    wiped[squareOfName('b1')] = 'l';
    const o = await seeded('play-on', wiped, 'host', 30);
    await o.allowed('dark takes the last light disc and plays on (rules cannot search)', o.dbFor.host,
      patched(moveOps(o.id, o.stored(), squareOfName('c1')), { status: 'playing', winner: '' }));
    if (verifyMove(o.stored())) o.failures.push('replay missed a game that should have ended');
    n.failures.push(...o.failures);

    const r = new Match('resign');
    await r.createAndJoin(false);
    const resign = (data: Data): WriteOp[] => [{ type: 'update', path: r.path, data }];
    await r.denied('a stranger resigns the match', r.stranger, resign({ status: 'resigned', winner: 'host' }));
    await r.denied('light resigns for dark', r.dbFor.guest, resign({ status: 'resigned', winner: 'guest' }));
    await r.denied('resign and flip a disc', r.dbFor.guest, resign({ status: 'resigned', winner: 'host', board: { ...r.stored().board, '44': 'd' } }));
    await r.allowed('light resigns', r.dbFor.guest, resign({ status: 'resigned', winner: 'host' }));
    expect([...m.failures, ...n.failures, ...r.failures]).toEqual([]);
  }, 60_000);
});
