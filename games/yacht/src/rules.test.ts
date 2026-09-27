/**
 * Yacht Security Rules against Pyric's sandbox. Seeded games with 2, 3 and 4
 * players run through the same write lists the browser applies, each write as
 * the acting player's identity. Every real action must be allowed; before each
 * one, a set of cheats derived from it must be denied and leave nothing
 * changed. Seeded endings cover ties and every order of final totals, and a
 * fixed-dice table covers each category's points.
 *
 * Removal probes (.overnight/probe-yacht.ts, 132 checks): 119 caught. The 13
 * not caught are implied by other checks:
 *   - `request.auth != null` in all seven transitions: each also compares
 *     request.auth.uid (host, players[turn], players[seat], `in players`),
 *     which errors without auth, so the rule denies.
 *   - yachtFinal `w >= 0 && w < n`: t[w] errors outside the list; naming
 *     seat -1 or seat n is denied either way.
 *   - yachtNonce and yachtReveal `before.status == 'playing'`: only a commit
 *     sets `commit`, a commit needs 'playing', and every score (including the
 *     last) needs `commit == ''`, so `before.commit != ''` implies playing.
 *   - yachtReveal `before.commit != ''`: SHA-256 of a salt is never ''.
 *   - yachtScore `before.status == 'playing'`: a waiting or finished match
 *     has rolls 0 and can't gain a roll (reveal needs a commit), so
 *     `before.rolls > 0` implies playing.
 *   - yachtPoints `cat == 'yacht'` in the last branch: cat must be a key of
 *     the card, and every other key has an earlier branch.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { mulberry32 } from '@games/harness';
import { CATEGORIES, freshCard, points, unused, type Category } from './scoring.ts';
import {
  afterCommit,
  afterNonce,
  afterReveal,
  afterScore,
  afterStart,
  bestCategory,
  commitmentOf,
  commitOps,
  createdMatch,
  derivedFaces,
  emptyNonces,
  joinOps,
  matchPath,
  missingNonces,
  nonceOps,
  NO_KEEP,
  randomHex,
  revealOps,
  scoreKey,
  scoreOps,
  startOps,
  totalTurns,
  updateOps,
  type WriteOp,
  type YachtMatch,
} from './logic.ts';

const rules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();

type Db = ReturnType<typeof getFirestore>;
type Data = Record<string, unknown>;

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

/** The same update without `keys`. */
function without(ops: WriteOp[], ...keys: string[]): WriteOp[] {
  return ops.map((op) => ({ ...op, data: Object.fromEntries(Object.entries(op.data).filter(([k]) => !keys.includes(k))) }));
}

class Table {
  readonly sandbox = initializeSandbox();
  readonly failures: string[] = [];
  readonly stranger: Db;
  private readonly dbs = new Map<string, Db>();

  constructor(readonly id: string, readonly uids: string[]) {
    getFirestore(this.sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(rules);
    for (const uid of uids) this.dbs.set(uid, getFirestore(this.sandbox.withAuth({ uid })));
    this.stranger = getFirestore(this.sandbox.withAuth({ uid: 'stranger' }));
  }

  as(uid: string): Db {
    return this.dbs.get(uid)!;
  }

  stored(): Data | null {
    return this.sandbox.admin.getDocument(matchPath(this.id)) as Data | null;
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

  /** The stored match must equal the model, field by field. */
  check(m: YachtMatch, label: string): void {
    const stored = this.stored() ?? {};
    for (const key of Object.keys(m) as (keyof YachtMatch)[]) {
      if (JSON.stringify(stored[key]) !== JSON.stringify(m[key])) {
        this.failures.push(`${label}: stored ${key} ${JSON.stringify(stored[key])}, expected ${JSON.stringify(m[key])}`);
      }
    }
  }
}

const other = (m: YachtMatch, seat: number) => m.players[(seat + 1) % m.players.length];

/** One roll: commit, every other seat's nonce, reveal; with cheats before each write. */
async function roll(t: Table, m: YachtMatch, keep: boolean[], random: () => number): Promise<YachtMatch> {
  const { id } = t;
  const roller = m.players[m.turn];
  const salt = randomHex(32, random);
  const commit = commitmentOf(salt);

  // Commit.
  const commitReal = commitOps(id, m, commit, keep);
  await t.denied('commit out of turn', t.as(other(m, m.turn)), commitReal);
  await t.denied('commit by a stranger', t.stranger, commitReal);
  await t.denied('commit a lowercase hash', t.as(roller), patched(commitReal, { commit: commit.toLowerCase() }));
  await t.denied('commit a short hash', t.as(roller), patched(commitReal, { commit: commit.slice(2) }));
  await t.denied('commit six keep flags', t.as(roller), patched(commitReal, { keep: [...keep, false] }));
  await t.denied('commit a keep flag that is not a boolean', t.as(roller), patched(commitReal, { keep: [0, ...keep.slice(1)] }));
  await t.denied('commit and change the dice', t.as(roller), patched(commitReal, { dice: [6, 6, 6, 6, 6] }));
  await t.denied('commit and fill a nonce', t.as(roller), patched(commitReal, { nonces: { ...afterCommit(m, commit, keep).nonces, [String((m.turn + 1) % m.players.length)]: randomHex(32, random) } }));
  if (m.rolls === 0) {
    await t.denied('keep dice on the first roll', t.as(roller), patched(commitReal, { keep: [true, false, false, false, false] }));
  } else {
    await t.denied("commit and keep the last roll's nonces", t.as(roller), without(commitReal, 'nonces'));
    await t.denied('score while a roll is pending (commit and score in one write)', t.as(roller), [
      { ...commitReal[0], data: { ...commitReal[0].data, ...scoreOps(id, m, bestCategory(m))[0].data, lastAction: 'commit' } },
    ]);
  }
  await t.denied('commit labeled as a nonce', t.as(roller), patched(commitReal, { lastAction: 'nonce' }));
  if (!(await t.allowed(`commit roll ${m.rolls + 1}`, t.as(roller), commitReal))) throw new Error(t.failures.join('\n'));
  m = afterCommit(m, commit, keep);
  t.check(m, 'after commit');
  await t.denied('commit twice', t.as(roller), commitOps(id, { ...m, commit: '' }, commitOf(random), keep));
  await t.denied('score while a roll is pending', t.as(roller), updateOps(id, { ...afterScoreUnchecked(m), lastAction: 'score' }));

  // Nonces, one per other seat.
  for (const seat of missingNonces(m)) {
    const uid = m.players[seat];
    const nonce = randomHex(32, random);
    const real = nonceOps(id, m, seat, nonce);
    const early = revealOps(id, fillNonces(m, random), salt);
    await t.denied('reveal before every nonce is in', t.as(roller), patched(early, { dice: revealedWith(m, salt) }));
    await t.denied('the roller adds a nonce for its own seat', t.as(roller), nonceOps(id, { ...m, turn: -1 }, m.turn, nonce));
    await t.denied('the roller adds a nonce for another seat', t.as(roller), real);
    await t.denied('a stranger adds a nonce', t.stranger, real);
    const neighbor = missingNonces(m).find((i) => i !== seat);
    if (neighbor !== undefined) {
      await t.denied("a nonce for another player's seat", t.as(uid), nonceOps(id, m, neighbor, nonce));
      await t.denied('nonces for two seats in one write', t.as(uid), patched(real, { nonces: { ...m.nonces, [String(seat)]: nonce, [String(neighbor)]: nonce } }));
    }
    await t.denied('a lowercase nonce', t.as(uid), nonceOps(id, m, seat, nonce.toLowerCase()));
    await t.denied('a short nonce', t.as(uid), nonceOps(id, m, seat, nonce.slice(1)));
    await t.denied('a nonce that also changes the dice', t.as(uid), patched(real, { dice: [1, 1, 1, 1, 1] }));
    await t.denied('nonce labeled as a commit', t.as(uid), patched(real, { lastAction: 'commit' }));
    if (!(await t.allowed(`nonce seat ${seat}`, t.as(uid), real))) throw new Error(t.failures.join('\n'));
    m = afterNonce(m, seat, nonce);
    await t.denied('rewrite a nonce already in', t.as(uid), nonceOps(id, { ...m, nonces: { ...m.nonces, [String(seat)]: '' } }, seat, randomHex(32, random)));
  }
  t.check(m, 'after nonces');

  // Reveal.
  const real = revealOps(id, m, salt);
  const after = afterReveal(m, salt);
  const otherSalt = randomHex(32, random);
  await t.denied('reveal a salt that does not match the commitment', t.as(roller), patched(real, { salt: otherSalt, dice: revealedWith(m, otherSalt) }));
  await t.denied('reveal a lowercase salt', t.as(roller), patched(real, { salt: salt.toLowerCase() }));
  const unkept = keep.findIndex((k) => !k);
  if (unkept >= 0) {
    const dice = after.dice.slice();
    dice[unkept] = (dice[unkept] % 6) + 1;
    await t.denied('reveal dice that differ from the derivation', t.as(roller), patched(real, { dice }));
  }
  const kept = keep.findIndex((k) => k);
  if (kept >= 0) {
    const dice = after.dice.slice();
    dice[kept] = (dice[kept] % 6) + 1;
    await t.denied('reveal and change a kept die', t.as(roller), patched(real, { dice }));
    const fresh = derivedFaces(salt, m.nonces);
    if (JSON.stringify(fresh) !== JSON.stringify(after.dice)) {
      await t.denied('reveal and reroll the kept dice too', t.as(roller), patched(real, { dice: fresh }));
    }
  }
  await t.denied('reveal six dice', t.as(roller), patched(real, { dice: [...after.dice, 1] }));
  await t.denied('reveal out of turn', t.as(other(m, m.turn)), real);
  await t.denied('reveal by a stranger', t.stranger, real);
  await t.denied('reveal without counting the roll', t.as(roller), patched(real, { rolls: m.rolls }));
  await t.denied('reveal and count two rolls', t.as(roller), patched(real, { rolls: m.rolls + 2 }));
  await t.denied('reveal and keep the commitment', t.as(roller), without(real, 'commit'));
  await t.denied('reveal and change a total', t.as(roller), patched(real, { totals: m.totals.map((x, i) => (i === m.turn ? x + 50 : x)) }));
  await t.denied('reveal and clear the nonces', t.as(roller), patched(real, { nonces: afterCommit({ ...m, commit: '' }, commit, keep).nonces }));
  await t.denied('reveal labeled as a score', t.as(roller), patched(real, { lastAction: 'score' }));
  if (!(await t.allowed(`reveal roll ${after.rolls}`, t.as(roller), real))) throw new Error(t.failures.join('\n'));
  t.check(after, 'after reveal');
  return after;
}

function commitOf(random: () => number): string {
  return commitmentOf(randomHex(32, random));
}

/** The dice a reveal of `salt` gives with the nonces as they stand. */
function revealedWith(m: YachtMatch, salt: string): number[] {
  const faces = derivedFaces(salt, m.nonces);
  return m.dice.map((d, i) => (m.keep[i] ? d : faces[i]));
}

/** `m` with the missing nonces filled, so revealOps builds a reveal update from it. */
function fillNonces(m: YachtMatch, random: () => number): YachtMatch {
  const nonces = { ...m.nonces };
  for (const seat of missingNonces(m)) nonces[String(seat)] = randomHex(32, random);
  return { ...m, nonces };
}

/** A score update built as if no roll were pending. */
function afterScoreUnchecked(m: YachtMatch): YachtMatch {
  const open = { ...m, commit: '', rolls: Math.max(1, m.rolls) };
  return afterScore(open, unused(open.scores[scoreKey(open.turn)])[0]);
}

/** Score `category` for the player on turn, with cheats first. */
async function score(t: Table, m: YachtMatch, category: Category): Promise<YachtMatch> {
  const { id } = t;
  const uid = m.players[m.turn];
  const key = scoreKey(m.turn);
  const real = scoreOps(id, m, category);
  const next = afterScore(m, category);
  const earned = points(category, m.dice);
  const data = real[0].data as { scores: Record<string, Record<string, number>>; totals: number[] };

  await t.denied('score out of turn', t.as(other(m, m.turn)), real);
  await t.denied('score by a stranger', t.stranger, real);
  await t.denied('score one point too many', t.as(uid), patched(real, {
    scores: { ...data.scores, [key]: { ...data.scores[key], [category]: earned + 1 } },
    totals: data.totals.map((x, i) => (i === m.turn ? x + 1 : x)),
  }));
  if (earned > 0) {
    await t.denied('score zero instead of the points', t.as(uid), patched(real, {
      scores: { ...data.scores, [key]: { ...data.scores[key], [category]: 0 } },
      totals: m.totals,
    }));
  }
  if (earned > 0) await t.denied('score without adding to the total', t.as(uid), patched(real, { totals: m.totals }));
  for (let j = 0; j < m.players.length; j++) {
    if (j !== m.turn) await t.denied(`score and change seat ${j}'s total`, t.as(uid), patched(real, { totals: data.totals.map((x, i) => (i === j ? x + 1 : x)) }));
  }
  await t.denied('score and add a total for a seat that does not exist', t.as(uid), patched(real, { totals: [...data.totals, 0] }));
  await t.denied('score the wrong points on the card with the right total', t.as(uid), patched(real, {
    scores: { ...data.scores, [key]: { ...data.scores[key], [category]: earned + 1 } },
  }));
  const second = unused(m.scores[key]).find((c) => c !== category);
  if (second) {
    await t.denied('score two categories at once', t.as(uid), patched(real, {
      scores: { ...data.scores, [key]: { ...data.scores[key], [second]: points(second, m.dice) } },
      totals: data.totals.map((x, i) => (i === m.turn ? x + points(second, m.dice) : x)),
    }));
  }
  const used = CATEGORIES.find((c) => m.scores[key][c] !== -1);
  if (used) {
    const p = points(used, m.dice);
    await t.denied('score a used category again', t.as(uid), patched(real, {
      lastCategory: used,
      scores: { ...m.scores, [key]: { ...m.scores[key], [used]: p } },
      totals: m.totals.map((x, i) => (i === m.turn ? x + p : x)),
    }));
  }
  const otherSeat = (m.turn + 1) % m.players.length;
  const otherKey = scoreKey(otherSeat);
  if (m.scores[otherKey][category] === -1) {
    await t.denied("score into another player's card", t.as(uid), patched(real, {
      scores: { ...m.scores, [otherKey]: { ...m.scores[otherKey], [category]: earned } },
      totals: m.totals.map((x, i) => (i === otherSeat ? x + earned : x)),
    }));
  }
  const blank = CATEGORIES.find((c) => m.scores[otherKey][c] === -1);
  if (blank) {
    await t.denied("score and also fill another player's card", t.as(uid), patched(real, {
      scores: { ...data.scores, [otherKey]: { ...m.scores[otherKey], [blank]: 0 } },
    }));
  }
  await t.denied('score labeled as a reveal', t.as(uid), patched(real, { lastAction: 'reveal' }));
  await t.denied('score and keep the turn', t.as(uid), patched(real, { turn: next.status === 'playing' ? m.turn : (m.turn + 1) % m.players.length }));
  await t.denied('score and skip the next player', t.as(uid), patched(real, { turn: (m.turn + 2) % m.players.length === next.turn ? (m.turn + 3) % m.players.length : (m.turn + 2) % m.players.length }));
  await t.denied('score without resetting the rolls', t.as(uid), patched(real, { rolls: m.rolls }));
  await t.denied('score without counting the move', t.as(uid), patched(real, { moveCount: m.moveCount }));
  await t.denied('score and change the dice', t.as(uid), patched(real, { dice: [6, 6, 6, 6, 6] }));
  await t.denied('score an unknown category', t.as(uid), patched(real, { lastCategory: 'bonus', scores: { ...m.scores, [key]: { ...m.scores[key], bonus: 35 } } }));
  if (next.status === 'playing') {
    const end = afterScore({ ...m, moveCount: totalTurns(m) - 1 }, category);
    await t.denied('claim the game is over early', t.as(uid), patched(real, { status: end.status, winner: end.winner, turn: m.turn }));
    await t.denied('name a winner while playing', t.as(uid), patched(real, { winner: m.turn }));
    await t.denied('end the game early without a winner', t.as(uid), patched(real, { status: 'won' }));
  } else {
    await t.denied('end the game still playing', t.as(uid), patched(real, { status: 'playing', winner: -1, turn: (m.turn + 1) % m.players.length }));
    // Every other seat as the winner, each with the status its totals would give.
    for (let w = 0; w < m.players.length; w++) {
      if (w === next.winner) continue;
      const tie = next.totals.some((x, k) => k > w && x === next.totals[w]);
      await t.denied(`name seat ${w} the winner`, t.as(uid), patched(real, { winner: w, status: tie ? 'draw' : 'won' }));
    }
    await t.denied(next.status === 'won' ? 'call a win a draw' : 'call a draw a win', t.as(uid), patched(real, { status: next.status === 'won' ? 'draw' : 'won' }));
    await t.denied('name no winner', t.as(uid), patched(real, { winner: -1 }));
    await t.denied('name a winner past the last seat', t.as(uid), patched(real, { winner: m.players.length }));
  }
  if (!(await t.allowed(`score ${category}`, t.as(uid), real))) throw new Error(t.failures.join('\n'));
  t.check(next, `after score ${category}`);
  return next;
}

async function lobby(t: Table, random: () => number): Promise<YachtMatch> {
  const { id, uids } = t;
  const host = uids[0];
  const fresh = { ...createdMatch(host), createdAt: FieldValue.serverTimestamp() };
  const create = (data: Data): WriteOp[] => [{ type: 'set', path: matchPath(id), data }];
  await t.denied('create for someone else', t.as(uids[1]), create(fresh));
  await t.denied('create with a scored card', t.as(host), create({ ...fresh, scores: { s0: { ...freshCard(), yacht: 50 } }, totals: [50] }));
  await t.denied('create with a card', t.as(host), create({ ...fresh, scores: { s0: freshCard() } }));
  await t.denied('create hosted by someone else', t.as(host), create({ ...fresh, host: uids[1] }));
  await t.denied('create already playing', t.as(host), create({ ...fresh, status: 'playing' }));
  await t.denied('create with a pending commitment', t.as(host), create({ ...fresh, commit: commitOf(random) }));
  await t.denied('create with dice rolled', t.as(host), create({ ...fresh, dice: [6, 6, 6, 6, 6] }));
  await t.denied('create with an extra field', t.as(host), create({ ...fresh, bonus: 35 }));
  await t.denied('create with two players', t.as(host), create({ ...fresh, players: [host, uids[1]] }));
  await t.denied('create with moves counted', t.as(host), create({ ...fresh, moveCount: 3 }));
  await t.denied('create on turn 2', t.as(host), create({ ...fresh, turn: 1 }));
  await t.denied('create with a roll counted', t.as(host), create({ ...fresh, rolls: 2 }));
  await t.denied('create with dice kept', t.as(host), create({ ...fresh, keep: [true, true, true, true, true] }));
  await t.denied('create with a winner', t.as(host), create({ ...fresh, winner: 0 }));
  await t.denied('create with a revealed salt', t.as(host), create({ ...fresh, salt: randomHex(32, random) }));
  await t.denied('create with a nonce', t.as(host), create({ ...fresh, nonces: { '0': randomHex(32, random) } }));
  await t.denied('create with a total', t.as(host), create({ ...fresh, totals: [0] }));
  await t.denied('create as another action', t.as(host), create({ ...fresh, lastAction: 'score' }));
  await t.denied('create with a nonce seat', t.as(host), create({ ...fresh, lastSeat: 1 }));
  await t.denied('create with a category named', t.as(host), create({ ...fresh, lastCategory: 'yacht' }));
  await t.denied('create with a client time', t.as(host), create({ ...fresh, createdAt: new Date(0) }));
  if (!(await t.allowed('create', t.as(host), create(fresh)))) throw new Error(t.failures.join('\n'));
  let m = createdMatch(host);

  await t.denied('start alone with four seats set up', t.as(host), [{ type: 'update', path: matchPath(id), data: {
    status: 'playing', nonces: emptyNonces(4), scores: Object.fromEntries([0, 1, 2, 3].map((i) => [scoreKey(i), freshCard()])), totals: [0, 0, 0, 0], lastAction: 'start',
  } }]);
  await t.denied('start alone', t.as(host), startOps(id, { ...m, players: [host, 'ghost'] }).map((op) => ({ ...op, data: { ...op.data, nonces: { '0': '' }, scores: { s0: freshCard() }, totals: [0] } })));
  for (const uid of uids.slice(1)) {
    const real = joinOps(id, m, uid);
    await t.denied('join as someone else', t.stranger, real);
    await t.denied('join and change the host', t.as(uid), patched(real, { host: uid }));
    await t.denied('join and start the game', t.as(uid), patched(real, { status: 'playing' }));
    await t.denied('join in front of the others', t.as(uid), patched(real, { players: [uid, ...m.players] }));
    await t.denied('join twice in one write', t.as(uid), patched(real, { players: [...m.players, uid, uid] }));
    await t.denied('join labeled as a start', t.as(uid), patched(real, { lastAction: 'start' }));
    if (!(await t.allowed(`join ${uid}`, t.as(uid), real))) throw new Error(t.failures.join('\n'));
    m = { ...m, players: [...m.players, uid], lastAction: 'join' };
    await t.denied('non-host starts', t.as(uid), startOps(id, m));
    await t.denied('join twice', t.as(uid), [{ type: 'update', path: matchPath(id), data: { players: [...m.players, uid], lastAction: 'join' } }]);
  }
  if (uids.length === 4) {
    await t.denied('a fifth player joins', t.stranger, [{ type: 'update', path: matchPath(id), data: { players: [...m.players, 'stranger'], lastAction: 'join' } }]);
  }
  try {
    await t.as(uids[1]).doc(matchPath(id)).delete();
    t.failures.push('allowed: a guest deletes the waiting match');
  } catch { /* denied */ }

  const start = startOps(id, m);
  const started = afterStart(m);
  await t.denied('start with a card already scored', t.as(host), patched(start, { scores: { ...started.scores, s1: { ...freshCard(), yacht: 50 } } }));
  await t.denied('start with a card missing', t.as(host), patched(start, { scores: Object.fromEntries(Object.entries(started.scores).slice(1)) }));
  await t.denied('start with a head start', t.as(host), patched(start, { totals: started.totals.map((x, i) => (i === 0 ? 10 : x)) }));
  await t.denied('start with a nonce filled', t.as(host), patched(start, { nonces: { ...started.nonces, '1': randomHex(32, random) } }));
  await t.denied('start on another seat', t.as(host), patched(start, { turn: 1 }));
  await t.denied('start and add a player', t.as(host), patched(start, { players: [...m.players, 'ghost'] }));
  await t.denied('start already finished', t.as(host), patched(start, { status: 'won' }));
  await t.denied('start labeled as a join', t.as(host), patched(start, { lastAction: 'join' }));
  if (!(await t.allowed('start', t.as(host), start))) throw new Error(t.failures.join('\n'));
  m = started;
  t.check(m, 'after start');
  await t.denied('join after start', t.stranger, [{ type: 'update', path: matchPath(id), data: { players: [...m.players, 'stranger'], lastAction: 'join' } }]);
  await t.denied('start again', t.as(host), startOps(id, { ...m, status: 'waiting' }));
  try {
    await t.as(host).doc(matchPath(id)).delete();
    t.failures.push('allowed: the host deletes a started match');
  } catch { /* denied */ }
  return m;
}

/** A turn: one to three rolls with random keeps, then a category. */
async function turn(t: Table, m: YachtMatch, random: () => number): Promise<YachtMatch> {
  const uid = m.players[m.turn];
  // Scoring before rolling reuses the last player's dice.
  if (m.moveCount > 0) {
    await t.denied('score before rolling', t.as(uid), updateOps(t.id, { ...afterScoreUnchecked(m), lastAction: 'score' }));
  }
  if (m.commit === '') {
    const seat = (m.turn + 1) % m.players.length;
    await t.denied('a nonce before the roller commits', t.as(m.players[seat]), [{ type: 'update', path: matchPath(t.id), data: {
      nonces: { ...emptyNonces(m.players.length), [String(seat)]: randomHex(32, random) }, lastSeat: seat, lastAction: 'nonce',
    } }]);
  }
  const rolls = 1 + Math.floor(random() * 3);
  m = await roll(t, m, NO_KEEP, random);
  for (let r = 1; r < rolls; r++) {
    const keep = m.dice.map(() => random() < 0.5);
    m = await roll(t, m, keep, random);
  }
  if (m.rolls === 3) {
    await t.denied('a fourth roll', t.as(uid), [{ type: 'update', path: matchPath(t.id), data: { commit: commitOf(random), keep: NO_KEEP, nonces: emptyNonces(m.players.length), lastAction: 'commit' } }]);
  }
  const open = unused(m.scores[scoreKey(m.turn)]);
  const category = random() < 0.7 ? bestCategory(m) : open[Math.floor(random() * open.length)];
  return score(t, m, category);
}

async function playGame(seed: number, players: number): Promise<{ failures: string[]; m: YachtMatch }> {
  const random = mulberry32(seed);
  const t = new Table(`m${seed}`, Array.from({ length: players }, (_, i) => `player-${i}`));
  let m = await lobby(t, random);
  while (m.status === 'playing') m = await turn(t, m, random);
  await t.denied('roll after the game ends', t.as(m.players[m.turn]), [{ type: 'update', path: matchPath(t.id), data: { commit: commitOf(random), keep: NO_KEEP, nonces: emptyNonces(m.players.length), lastAction: 'commit' } }]);
  await t.denied('score after the game ends', t.as(m.players[m.turn]), updateOps(t.id, { ...afterScoreUnchecked({ ...m, status: 'playing', scores: { ...m.scores, [scoreKey(m.turn)]: { ...m.scores[scoreKey(m.turn)], choice: -1 } } }), lastAction: 'score' }));
  return { failures: t.failures, m };
}

/**
 * Seed a match one score from the end: every card full except `open` on the
 * last seat. Roll for real, set the totals before that score from the roll's
 * sum with `totalsFor`, then score for real.
 */
async function ending(seed: number, players: number, totalsFor: (sum: number) => number[], open: Category): Promise<{ failures: string[]; m: YachtMatch }> {
  const random = mulberry32(seed);
  const t = new Table(`end${seed}`, Array.from({ length: players }, (_, i) => `player-${i}`));
  const last = players - 1;
  const full = (seat: number) => {
    const card = freshCard();
    for (const c of CATEGORIES) card[c] = 0;
    if (seat === last) card[open] = -1;
    return card;
  };
  let m: YachtMatch = {
    ...afterStart({ ...createdMatch('player-0'), players: t.uids }),
    scores: Object.fromEntries(t.uids.map((_, i) => [scoreKey(i), full(i)])),
    totals: t.uids.map(() => 0),
    turn: last,
    moveCount: totalTurns({ players: t.uids }) - 1,
    lastAction: 'score',
  };
  t.sandbox.admin.setDocument(matchPath(t.id), { ...m, createdAt: new Date() });
  m = await roll(t, m, NO_KEEP, random);
  m = { ...m, totals: totalsFor(m.dice.reduce((a, b) => a + b, 0)) };
  t.sandbox.admin.setDocument(matchPath(t.id), { ...(t.stored() as Data), totals: m.totals });
  m = await score(t, m, open);
  return { failures: t.failures, m };
}

describe('Yacht Security Rules', () => {
  for (const players of [2, 3, 4]) {
    test(`${players} players: every real action allowed, every cheat denied`, async () => {
      const { failures, m } = await playGame(players * 7, players);
      expect(failures.slice(0, 20)).toEqual([]);
      expect(m.moveCount).toBe(12 * players);
      expect(['won', 'draw']).toContain(m.status);
    }, 120_000);
  }

  test('a tie for the top total ends in a draw', async () => {
    // Seat 1 scores choice last, which adds the roll's sum; seat 0 already has that much more.
    const { failures, m } = await ending(3, 2, (sum) => [100 + sum, 100], 'choice');
    expect(failures).toEqual([]);
    expect(m.status).toBe('draw');
    expect(m.winner).toBe(0);
  }, 60_000);

  // Final scores for four players: the top seat in each place, with the others
  // arranged so that naming each wrong seat breaks exactly one ordering check.
  const endings: Array<[string, (sum: number) => number[], number, string]> = [
    ['seat 0 on top', () => [200, 100, 20, 30], 0, 'won'],
    ['seat 1 on top, seat 0 second', () => [100, 200, 50, 20], 1, 'won'],
    ['seat 1 on top, seat 0 last', () => [10, 200, 50, 20], 1, 'won'],
    ['seat 2 on top', () => [10, 20, 200, 50], 2, 'won'],
    ['seat 2 on top, seat 0 second', () => [100, 50, 200, 20], 2, 'won'],
    ['seat 3 on top', () => [100, 20, 50, 200], 3, 'won'],
    ['seats 0 and 2 tie', () => [100, 10, 100, 40], 0, 'draw'],
    ['seats 0 and 3 tie', (sum) => [100 + sum, 10, 20, 100], 0, 'draw'],
  ];
  endings.forEach(([name, totalsFor, winner, status], i) => {
    test(`four players end: ${name}`, async () => {
      const { failures, m } = await ending(100 + i, 4, totalsFor, 'choice');
      expect(failures).toEqual([]);
      expect(m.status).toBe(status);
      expect(m.winner).toBe(winner);
    }, 60_000);
  });

  test('every category scores exactly its points from fixed dice', async () => {
    const t = new Table('fixed', ['player-0', 'player-1']);
    const base = afterStart({ ...createdMatch('player-0'), players: t.uids });
    const hands = [[2, 2, 2, 2, 5], [3, 5, 3, 3, 3], [5, 3, 3, 3, 3], [2, 2, 3, 3, 3], [1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [4, 4, 4, 4, 4], [1, 1, 2, 4, 1], [6, 6, 6, 2, 6], [1, 3, 4, 5, 6]];
    for (const dice of hands) {
      for (const category of CATEGORIES) {
        const m: YachtMatch = { ...base, dice, rolls: 1, salt: '0'.repeat(32), lastAction: 'reveal' };
        t.sandbox.admin.setDocument(matchPath(t.id), { ...m, createdAt: new Date() });
        const real = scoreOps(t.id, m, category);
        const earned = points(category, dice);
        const sum = dice.reduce((a, b) => a + b, 0);
        const claims = new Set([earned + 1, earned === 0 ? sum : 0, earned === 0 ? 30 : earned - 1, earned === 0 ? 50 : earned * 2]);
        claims.delete(earned);
        for (const claim of claims) {
          await t.denied(`${category} on ${dice.join('')} for ${claim}`, t.as('player-0'), patched(real, {
            scores: { ...m.scores, s0: { ...m.scores.s0, [category]: claim } },
            totals: [claim, 0],
          }));
        }
        await t.allowed(`${category} on ${dice.join('')} for ${earned}`, t.as('player-0'), real);
      }
    }
    expect(t.failures).toEqual([]);
  }, 60_000);

  test('a salt outside the format is refused even when it matches the commitment', async () => {
    const t = new Table('salt', ['player-0', 'player-1']);
    let m = afterStart({ ...createdMatch('player-0'), players: t.uids });
    t.sandbox.admin.setDocument(matchPath(t.id), { ...m, createdAt: new Date() });
    const salt = randomHex(32, mulberry32(1)).toLowerCase() + 'z';
    await t.allowed('commit to an odd salt', t.as('player-0'), commitOps(t.id, m, commitmentOf(salt), NO_KEEP));
    m = afterCommit(m, commitmentOf(salt), NO_KEEP);
    await t.allowed('nonce', t.as('player-1'), nonceOps(t.id, m, 1, 'A'.repeat(32)));
    m = afterNonce(m, 1, 'A'.repeat(32));
    await t.denied('reveal the odd salt', t.as('player-0'), [{ type: 'update', path: matchPath(t.id), data: {
      salt, dice: derivedFaces(salt, m.nonces), rolls: 1, commit: '', lastAction: 'reveal',
    } }]);
    expect(t.failures).toEqual([]);
  }, 60_000);

  test('the last seat can win on the last score', async () => {
    const { failures, m } = await ending(5, 3, () => [40, 60, 59], 'choice');
    expect(failures).toEqual([]);
    expect(m.status).toBe('won');
    expect(m.winner).toBe(2);
  }, 60_000);
});
