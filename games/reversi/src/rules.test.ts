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
 *
 * Removal probes (tools/removal-probe.ts on each check, 70 checks): 62
 * caught. The 8 not caught are implied by other checks:
 *   - `request.auth != null` in reversiMove, reversiPass and reversiResign:
 *     each also compares request.auth.uid (isMyTurn, or the participant
 *     check), which errors without auth, so the rule denies.
 *   - reversiPass `isPlaying()`: the pass gate requires the stored status
 *     after the write to be 'playing', and onlyFieldsChanged leaves status
 *     out, so the status before was 'playing' too.
 *   - reversiMove `r.hasOnly([0, ..., 7])`: each reach indexes its
 *     direction's line of at most eight entries, so a reach that is not an
 *     integer from 0 to the line's length errors and denies.
 *   - Main gate `lastMove.at != ''` on a move: int('') and b[''] error, so
 *     reversiMove denies.
 *   - Main gates `lastMove.at == ''` and `status == 'playing'` on a pass:
 *     reversiPass pins lastMove to {at: '', runs: []}, and its
 *     onlyFieldsChanged with isPlaying keeps status 'playing'.
 *   These gates stay: each makes the other transitions stop at one
 *   comparison, which keeps a write's evaluation cost to its own rule.
 */
import { describe, expect, test } from 'bun:test';
import { firestoreRules } from 'pyric/rules';
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
  squareOfKey,
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
      const full = fresh.full as { d: BoardMap; l: BoardMap };
      await this.denied('create with a light disc in the full dark board', host, create({ ...fresh, full: { ...full, d: { ...full.d, '11': 'l' } } }));
      await this.denied('create with a square missing from the full light board', host,
        create({ ...fresh, full: { ...full, l: Object.fromEntries(Object.entries(full.l).filter(([k]) => k !== '11')) } }));
      await this.denied('create with a full board keyed off the board', host,
        create({ ...fresh, full: { ...full, d: { ...Object.fromEntries(Object.entries(full.d).filter(([k]) => k !== '11')), '19': 'd' } } }));
      await this.denied('create with only the full dark board', host, create({ ...fresh, full: { d: full.d } }));
      await this.denied('create with a third full board', host, create({ ...fresh, full: { ...full, x: full.d } }));
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
    if (withCheats) {
      await this.denied('join a full match', this.stranger, join({ guest: 'stranger-uid' }));
      const cancel = (db: Db) => db.doc(this.path).delete();
      const before = JSON.stringify(this.stored());
      for (const [label, db] of [['the host cancels a match in play', this.dbFor.host], ['the guest cancels a match in play', this.dbFor.guest]] as const) {
        try {
          await cancel(db);
          this.failures.push(`allowed: ${label}`);
        } catch {
          // denied
        }
      }
      if (JSON.stringify(this.stored()) !== before) this.failures.push('changed state: cancel a match in play');
    }
  }
}

const otherSeat = (seat: Seat): Seat => (seat === 'host' ? 'guest' : 'host');

/** The squares at distance 1..n from `sq` in direction `dir`. */
function ray(sq: number, dir: number, n: number): number[] {
  const [df, dr] = DIRECTIONS[dir];
  return Array.from({ length: n }, (_, k) => squareAt(fileOf(sq) + (k + 1) * df, rankOf(sq) + (k + 1) * dr));
}

/**
 * Cheats derived from the real move at `sq`, each denied with nothing
 * changed. A forged board is sent with the counts the rules expect for the
 * stored runs (the mover gains the claimed flips and the placed disc), so
 * the counts agree with the claim and the board checks are what deny it.
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
  /** The write with `board`, the move stored as `runs` at `at`, and the counts those runs claim. */
  const forgedBoard = (board: Board, extra: { lastMove?: { at: string; runs: number[] } } = {}): WriteOp[] => {
    const lastMove = extra.lastMove ?? { at: key, runs: placed.runs };
    const from = lastMove.at === key ? sq : squareOfKey(lastMove.at);
    const claimed = lastMove.runs.reduce((sum, n, dir) => {
      const end = ray(from, dir, n + 1)[n];
      return sum + (n > 0 && end >= 0 && before[end] === me ? n : 0);
    }, 0);
    const tally = { ...doc.counts, [me]: doc.counts[me] + claimed + 1, [op]: doc.counts[op] - claimed };
    // A game the real move ends names the winner these counts give, so the result check passes too.
    const result = up.status === 'playing' ? {}
      : tally.d === tally.l ? { status: 'draw', winner: '' } : { status: 'won', winner: tally.d > tally.l ? 'host' : 'guest' };
    return patched(real, { board: toMap(board), counts: tally, lastMove, ...result });
  };

  await m.denied('move out of turn', m.dbFor[otherSeat(seat)], real);
  await m.denied('a stranger moves', m.stranger, real);

  for (let dir = 0; dir < 8; dir++) {
    const n = flipsIn(before, sq, me, dir);
    const r = reach(before, sq, me, dir);
    if (n > 0) {
      // The run left unflipped, with its reach stored honestly, then claimed as 0.
      const missed = placed.board.slice();
      for (const s of ray(sq, dir, n)) missed[s] = op;
      await m.denied(`miss the flip in direction ${dir}`, db, forgedBoard(missed));
      const runs = placed.runs.slice();
      runs[dir] = 0;
      await m.denied(`miss the flip in direction ${dir} and store no reach`, db, forgedBoard(missed, { lastMove: { at: key, runs } }));
      // Only the first disc of a longer run flipped.
      if (n > 1) {
        const partial = placed.board.slice();
        for (const s of ray(sq, dir, n).slice(1)) partial[s] = op;
        await m.denied(`flip part of the run in direction ${dir}`, db, forgedBoard(partial));
      }
      // Each disc of the run emptied instead of flipped.
      for (const [k, s] of ray(sq, dir, n).entries()) {
        const emptied = placed.board.slice();
        emptied[s] = '';
        await m.denied(`empty flipped disc ${k + 1} in direction ${dir}`, db, forgedBoard(emptied));
      }
      // Reach stored one short: the square past it is still the opponent's. Flip the shorter run, or nothing.
      runs[dir] = n - 1;
      const short = placed.board.slice();
      short[ray(sq, dir, n)[n - 1]] = op;
      await m.denied(`store the reach in direction ${dir} one short`, db, forgedBoard(short, { lastMove: { at: key, runs } }));
      if (n > 1) await m.denied(`store the reach in direction ${dir} one short and miss the flip`, db, forgedBoard(missed, { lastMove: { at: key, runs } }));
      // Reach stored one long, over the mover's own disc, to hide the flip.
      runs[dir] = n + 1;
      await m.denied(`store the reach in direction ${dir} over the mover's disc and miss the flip`, db, forgedBoard(missed, { lastMove: { at: key, runs } }));
    } else if (r > 0) {
      // An unbracketed run flipped, stored honestly and stored as bracketed.
      const extra = placed.board.slice();
      for (const s of ray(sq, dir, r)) extra[s] = me;
      await m.denied(`flip an unbracketed run in direction ${dir}`, db, forgedBoard(extra));
      const runs = placed.runs.slice();
      runs[dir] = r + 1;
      const past = ray(sq, dir, r + 1)[r];
      if (past >= 0 && before[past] === '') {
        // Claim one square past the run, and fill it with the mover's disc.
        const filled = extra.slice();
        filled[past] = me;
        await m.denied(`reach past the run in direction ${dir} onto an empty square`, db, forgedBoard(filled, { lastMove: { at: key, runs } }));
      }
    } else {
      // Nothing to flip: claim the neighbor as flipped.
      const near = ray(sq, dir, 1)[0];
      if (near >= 0) {
        const runs = placed.runs.slice();
        runs[dir] = 1;
        const claimed = placed.board.slice();
        claimed[near] = me;
        await m.denied(`claim the ${before[near] === me ? "mover's own" : 'empty'} neighbor in direction ${dir}`, db, forgedBoard(claimed, { lastMove: { at: key, runs } }));
      }
    }
  }

  const flipped = new Set(placed.flipped);
  const bystander = before.findIndex((c, s) => c === op && !flipped.has(s));
  if (bystander >= 0) {
    const extra = placed.board.slice();
    extra[bystander] = me;
    await m.denied('flip an extra opponent disc', db, forgedBoard(extra));
    await m.denied('flip an extra disc and keep the counts', db, patched(real, { board: toMap(extra) }));
    const tally = counts(extra);
    const result = up.status === 'playing' ? {}
      : tally.d === tally.l ? { status: 'draw', winner: '' } : { status: 'won', winner: tally.d > tally.l ? 'host' : 'guest' };
    await m.denied('flip an extra disc with counts that follow the board', db, patched(real, { board: toMap(extra), counts: tally, ...result }));
  }
  const own = before.findIndex((c) => c === me);
  if (own >= 0) {
    const turned = placed.board.slice();
    turned[own] = op;
    await m.denied("flip one of the mover's own discs", db, forgedBoard(turned));
    const removed = placed.board.slice();
    removed[own] = '';
    await m.denied("remove one of the mover's own discs", db, forgedBoard(removed));
  }
  const emptySquare = before.findIndex((c, s) => c === '' && s !== sq);
  if (emptySquare >= 0) {
    const added = placed.board.slice();
    added[emptySquare] = me;
    await m.denied('place a second disc', db, forgedBoard(added));
  }

  // A move on an occupied square: flips computed as if it were empty.
  for (const occupied of [before.findIndex((c) => c === op), before.findIndex((c) => c === me)]) {
    if (occupied < 0) continue;
    const emptied = before.slice();
    emptied[occupied] = '';
    const onTop = applyMove({ board: emptied, turn: me }, occupied);
    const kind = before[occupied] === me ? 'own' : "opponent's";
    await m.denied(`play on an ${kind} disc`, db, forgedBoard(onTop.board, { lastMove: { at: squareKey(occupied), runs: onTop.runs } }));
  }
  // An opponent's disc that brackets a run of its own side, taken over as a move.
  for (let s = 0; s < 64; s++) {
    if (before[s] !== op) continue;
    const emptied = before.slice();
    emptied[s] = '';
    const onTop = applyMove({ board: emptied, turn: me }, s);
    if (onTop.flipped.length === 0) continue;
    await m.denied("play a legal-looking move on an opponent's disc", db, forgedBoard(onTop.board, { lastMove: { at: squareKey(s), runs: onTop.runs } }));
    break;
  }

  // A move that flips nothing: an empty square with no bracketed run.
  const idle = before.findIndex((c, s) => c === '' && !legalMoves(pos).includes(s));
  if (idle >= 0) {
    const quiet = before.slice();
    quiet[idle] = me;
    await m.denied('play a square that flips nothing', db, forgedBoard(quiet, { lastMove: { at: squareKey(idle), runs: applyMove(pos, idle).runs } }));
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
    await m.denied('store a fractional reach and skip the flip', db, forgedBoard(missed, { lastMove: { at: key, runs } }));
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
  if (c.d === c.l) {
    await m.denied('name dark the winner on equal counts', db, patched(real, { status: 'won', winner: 'host' }));
    await m.denied('name light the winner on equal counts', db, patched(real, { status: 'won', winner: 'guest' }));
  }
  await m.denied('move and mark the match resigned', db, patched(real, { status: 'resigned', winner: c.d === c.l ? 'guest' : leader }));
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

/** The document before write `write` of the seeded random game, and the square it plays. */
function randomGameWrite(seed: number, write: number): { doc: ReversiDoc; sq: number } {
  const random = mulberry32(seed);
  let doc = joinedMatch(createdMatch(reversi, 'host-uid'), 'guest-uid') as ReversiDoc;
  while (doc.status === 'playing') {
    const moves = legalMoves(positionOf(doc.board, doc.currentTurn));
    const move = moves.length === 0 ? null : moves[Math.floor(random() * moves.length)];
    if (doc.moveCount + 1 === write && move !== null) return { doc, sq: move };
    doc = { ...doc, ...(move === null ? passUpdate(doc) : moveUpdate(doc, move)) } as ReversiDoc;
  }
  throw new Error(`seed ${seed} has no move at write ${write}`);
}

/** Expressions Pyric's simulator evaluates for the stored match's move at `sq`. */
function simulatedCost(m: Match, sq: number): number {
  const doc = JSON.parse(JSON.stringify(m.stored())) as ReversiDoc;
  const after = { ...doc, ...moveUpdate(doc, sq) };
  const [c] = firestoreRules(rules).simulate([{
    description: 'budget', expectation: 'ALLOW', method: 'update', path: m.path,
    auth: { uid: doc.currentTurn === 'host' ? 'host-uid' : 'guest-uid' }, resource: doc as never, data: after as never,
  }]).cases;
  if (c.decision !== 'ALLOW') throw new Error(`simulator denied the move: ${c.decision}`);
  return c.trace.flatMap((t) => t.expressionTrace ?? []).filter((e) => !e.skipped).length;
}

describe('Reversi Security Rules', () => {
  test('the rays table lists each square\'s squares to the edge in the order of runs[]', async () => {
    const source = await Bun.file(new URL('../reversi.rules', import.meta.url)).text();
    const table = /function reversiRays\(\) \{\s*return '([^']*)';/.exec(source)![1].split(' ');
    const expected: string[] = [];
    for (let key = 11; key <= 88; key++) {
      const file = (key % 10) - 1;
      const rank = Math.floor(key / 10);
      for (const [df, dr] of DIRECTIONS) {
        if (squareAt(file, rank) < 0) {
          expected.push('x');
          continue;
        }
        const line: string[] = [];
        for (let k = 1; squareAt(file + k * df, rank + k * dr) >= 0; k++) line.push(squareKey(squareAt(file + k * df, rank + k * dr)));
        expected.push([...line, 'x'].join('_'));
      }
    }
    expect(table).toEqual(expected);
  });

  // Budget sentinels: the most expensive moves measured against production's
  // limit of 1,000 evaluated expressions per request (Rules Test API, padding
  // method). Every move costs 640 to 800 there, so the rule has about 200 to
  // spare. A change to the move rule that raises these simulator counts needs
  // a new production measurement.
  test('the most expensive moves stay within the measured budget', async () => {
    const failures: string[] = [];
    const cases: { label: string; m: Match; sq: number; nodes: number }[] = [];
    // Production 797 to 802: eight directions with reach, 17 in all, two of them flipping.
    const worst = randomGameWrite(8, 54);
    cases.push({ label: 'seed 8 write 54', m: await seeded('budget8', fromMap(worst.doc.board), worst.doc.currentTurn, worst.doc.moveCount), sq: worst.sq, nodes: 678 });
    // Production 782 to 787: eight directions with reach, five of them flipping.
    const next = randomGameWrite(33, 44);
    cases.push({ label: 'seed 33 write 44', m: await seeded('budget33', fromMap(next.doc.board), next.doc.currentTurn, next.doc.moveCount), sq: next.sq, nodes: 678 });
    // Production 767 to 772: c3 flips in all eight directions, 17 discs, and ends the game.
    const board: Board = Array(64).fill('');
    for (const k of ['34', '35', '36', '37', '44', '55', '66', '77', '43', '53', '63', '73', '42', '32', '22', '23', '24']) board[squareOfKey(k)] = 'l';
    for (const k of ['38', '88', '83', '51', '31', '11', '13', '15']) board[squareOfKey(k)] = 'd';
    cases.push({ label: 'c3 in eight directions', m: await seeded('budget-c3', board, 'host', 20), sq: squareOfKey('33'), nodes: 677 });
    for (const { label, m, sq, nodes } of cases) {
      const cost = simulatedCost(m, sq);
      if (cost > nodes) failures.push(`${label}: ${cost} simulator expressions, above the measured ${nodes}`);
      await m.allowed(label, m.dbFor[m.stored().currentTurn], moveOps(m.id, m.stored(), sq));
      failures.push(...m.failures);
    }
    expect(failures).toEqual([]);
  });

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

    // Runs of every length a move can flip, 1 to 6, east from a1, with the cheats on each.
    for (let n = 1; n <= 6; n++) {
      const row: Board = Array(64).fill('');
      for (let k = 1; k <= n; k++) row[squareAt(k, 1)] = 'l';
      row[squareAt(n + 1, 1)] = 'd';
      row[squareOfName('h8')] = 'l';
      // A second run north (a2, bracketed by a3), so hiding the east flip still leaves a flip.
      row[squareOfName('a2')] = 'l';
      row[squareOfName('a3')] = 'd';
      const run = await seeded(`run${n}`, row, 'host', 20);
      await moveCheats(run, run.stored(), squareOfName('a1'));
      await run.allowed(`flip a run of ${n}`, run.dbFor.host, moveOps(run.id, run.stored(), squareOfName('a1')));
      if (!verifyMove(run.stored())) run.failures.push(`replay rejected a run of ${n}`);
      failures.push(...run.failures);
    }

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
    {
      // Once the match is over, even a legal move is denied.
      const over = n.stored();
      const reply = legalMoves(positionOf(over.board, 'guest'))[0];
      await n.denied('a legal move after the game ended', n.dbFor.guest, patched(moveOps(n.id, over, reply), { status: 'playing', winner: '' }));
    }

    // The opposite claim: dark takes the last light disc with squares left and plays on.
    const wiped: Board = Array(64).fill('');
    wiped[squareOfName('a1')] = 'd';
    wiped[squareOfName('b1')] = 'l';
    const o = await seeded('play-on', wiped, 'host', 30);
    await o.allowed('dark takes the last light disc and plays on (rules cannot search)', o.dbFor.host,
      patched(moveOps(o.id, o.stored(), squareOfName('c1')), { status: 'playing', winner: '' }));
    if (verifyMove(o.stored())) o.failures.push('replay missed a game that should have ended');
    n.failures.push(...o.failures);

    const k = new Match('cancel');
    await k.allowed('create', k.dbFor.host, [{ type: 'set', path: k.path, data: { ...createdMatch(reversi, 'host-uid'), createdAt: FieldValue.serverTimestamp() } }]);
    for (const [label, db] of [['a stranger cancels', k.stranger], ['the would-be guest cancels', k.dbFor.guest]] as const) {
      try {
        await db.doc(k.path).delete();
        k.failures.push(`allowed: ${label}`);
      } catch {
        // denied
      }
    }
    try {
      await k.dbFor.host.doc(k.path).delete();
    } catch (e) {
      k.failures.push(`denied: the host cancels a waiting match (${(e as Error).message})`);
    }
    if (k.stored()) k.failures.push('the cancelled match is still there');
    n.failures.push(...k.failures);

    const r = new Match('resign');
    await r.createAndJoin(false);
    const resign = (data: Data): WriteOp[] => [{ type: 'update', path: r.path, data }];
    await r.denied('a stranger resigns the match', r.stranger, resign({ status: 'resigned', winner: 'host' }));
    await r.denied('light resigns for dark', r.dbFor.guest, resign({ status: 'resigned', winner: 'guest' }));
    await r.denied('name the opponent the winner and play on', r.dbFor.guest, resign({ winner: 'host' }));
    await r.denied('concede as a win instead of a resignation', r.dbFor.guest, resign({ status: 'won', winner: 'host' }));
    await r.denied('resign and flip a disc', r.dbFor.guest, resign({ status: 'resigned', winner: 'host', board: { ...r.stored().board, '44': 'd' } }));
    await r.allowed('light resigns', r.dbFor.guest, resign({ status: 'resigned', winner: 'host' }));
    expect([...m.failures, ...n.failures, ...r.failures]).toEqual([]);
  }, 60_000);
});
