/**
 * Air hockey Security Rules against Pyric's sandbox: the Firestore rules
 * for the lobby and the result, and the Realtime Database rules for live
 * play, in one sandbox. Seeded matches run the host's physics to 7 goals
 * and send the same write lists the browser sends (logic.ts), each write as
 * the acting player. Every real write must be allowed; before the start,
 * every goal, the end, and every CHEAT_EVERY-th frame, a set of cheats
 * derived from the real write must be denied and leave both databases
 * unchanged.
 *
 * The Realtime Database rules are the generated app/database.rules.json,
 * which must match the TypeScript source (rtdb-rules.ts). Each
 * single-path Realtime Database write and each read is also run through
 * the ruleset handle's `simulate`, which must agree with the sandbox.
 *
 * What the rules can't check, the clients flag: a forfeit recorded in
 * Firestore while the other player was present, and a final score that
 * isn't the live one, are allowed by the Firestore rules (which can't read
 * the Realtime Database) and caught by resultMatchesLive.
 *
 * Removal probes (.overnight/probe-airhockey-rtdb.ts over the TypeScript
 * constraints through tools/removal-probe-rtdb.ts, 124 clauses; and
 * .overnight/probe-airhockey-fs.ts over airhockey.rules and its gates, 49
 * checks): 101 and 45 caught. The rest are implied by other checks.
 * Realtime Database (23):
 *   - malletIn's required x and y (3): each lower bound (at least 4.5)
 *     fails for a missing coordinate.
 *   - `authenticated()` in isHost, isGuestAt, the match read and the meta
 *     write (4): a signed-out request's auth.uid is null and never equals
 *     $host or meta's guest.
 *   - newDataExists() on meta (1): a deleted meta fails the status checks
 *     of both create and every ending.
 *   - meta's required status and winner, and the known status and winner
 *     lists (4): create pins 'playing' and '', and each ending
 *     pins its status and winner.
 *   - metaOver's host check and its status 'over' (2): only the host writes
 *     the score, and a score that reaches 7 must close meta as 'over' in the
 *     same write, so no one else ever finds a 7 with meta still playing.
 *   - The puck's vx and vy bounds (2): vx*vx + vy*vy <= 180*180 bounds each.
 *   - score's required() and its fields (3): every step branch compares
 *     both fields with numbers.
 *   - score's bounds (2): it starts at 0 to 0, moves by one goal a write,
 *     and closes at 7, after which nothing is written.
 *   - The root's .read and .write false (2): with no rule, RTDB denies.
 * Firestore (4):
 *   - `request.auth != null` in finish, forfeit and resign: each reads
 *     request.auth.uid, which errors without auth, so the rule denies.
 *   - The join gate `resource.data.status == 'waiting'`: validJoin checks
 *     that the match is waiting; the gate stays to keep other updates cheap.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, get, goOffline, onDisconnect, ref, set, update, sandbox as rtdbSandbox, type Database } from 'pyric/database';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { mulberry32 } from '@games/harness';
import { createdMatch, joinedMatch } from '@games/turn-net/transitions';
import {
  MALLET_R,
  WIN_SCORE,
  clampMallet,
  initialWorld,
  malletHome,
  servedPuck,
  step,
  winner,
  type Side,
  type Vec,
  type World,
} from './physics.ts';
import {
  airHockey,
  finishOps,
  forfeitMetaOp,
  forfeitOps,
  frameOf,
  frameOp,
  livePath,
  malletOp,
  matchPath,
  presenceOp,
  presencePath,
  resignMetaOp,
  resultMatchesLive,
  startLiveOp,
  startMetaOp,
  type AirHockeyDoc,
  type LiveMatch,
  type LiveOp,
  type WriteOp,
} from './logic.ts';
import { rtdbRules } from 'pyric/rules';
import { autopilot, type Plan } from './autopilot.ts';
import { renderRules, RULES_PATH } from '../../../tools/rtdb-rules.ts';

const firestoreRules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();
const databaseRulesText = await Bun.file(RULES_PATH).text();
const databaseRules = JSON.parse(databaseRulesText);
/** The generated JSON as a ruleset handle, to check its simulate against the sandbox. */
const jsonRules = rtdbRules(databaseRules);

const HOST = 'host-uid';
const GUEST = 'guest-uid';
const STRANGER = 'stranger-uid';
/** Cheats run before every CHEAT_EVERY-th frame, and before every goal. */
const CHEAT_EVERY = 250;
/** Every CROSS_CHECK_EVERY-th real write, and every cheat, is also run through `simulate`. */
const CROSS_CHECK_EVERY = 25;
/** The host writes a frame every WRITE_TICKS steps, as the client does. */
const WRITE_TICKS = 3;

type Fs = ReturnType<typeof getFirestore>;
type Data = Record<string, unknown>;
type Who = 'host' | 'guest' | 'stranger';
const uidOf: Record<Who, string> = { host: HOST, guest: GUEST, stranger: STRANGER };

async function applyFs(db: Fs, ops: WriteOp[]): Promise<void> {
  const batch = db.batch();
  for (const op of ops) {
    const r = db.doc(op.path);
    if (op.type === 'set') batch.set(r, op.data);
    else batch.update(r, op.data);
  }
  await batch.commit();
}

async function applyLive(db: Database, op: LiveOp): Promise<void> {
  if (op.type === 'set') await set(ref(db, op.path), op.value);
  else await update(ref(db, op.path), op.value);
}

class Match {
  readonly sandbox = initializeSandbox();
  readonly failures: string[] = [];
  readonly fs: Record<Who, Fs>;
  readonly rtdb: Record<Who, Database>;
  readonly admin: Database;
  readonly path: string;
  readonly base: string;
  /** Sandbox verdicts that `simulate` disagreed with. */
  readonly disagreements: string[] = [];
  simulated = 0;

  constructor(readonly id: string) {
    getFirestore(this.sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(firestoreRules);
    this.admin = getDatabase(this.sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
    rtdbSandbox.setRules(this.admin, databaseRules);
    this.fs = { host: this.fsFor(HOST), guest: this.fsFor(GUEST), stranger: this.fsFor(STRANGER) };
    this.rtdb = { host: this.dbFor(HOST), guest: this.dbFor(GUEST), stranger: this.dbFor(STRANGER) };
    this.path = matchPath(id);
    this.base = livePath(id, HOST);
  }

  private fsFor(uid: string): Fs {
    return getFirestore(this.sandbox.withAuth({ uid }));
  }

  dbFor(uid: string): Database {
    return getDatabase(this.sandbox.withAuth({ uid }));
  }

  stored(): AirHockeyDoc {
    return this.sandbox.admin.getDocument(this.path) as AirHockeyDoc;
  }

  tree(): Data {
    return (rtdbSandbox.snapshotState(this.admin) ?? {}) as Data;
  }

  live(): LiveMatch | null {
    const t = this.tree() as { airhockey?: Record<string, Record<string, LiveMatch>> };
    return t.airhockey?.[this.id]?.[HOST] ?? null;
  }

  private state(): string {
    return JSON.stringify([this.stored() ?? null, this.tree()]);
  }

  // ─── Firestore ─────────────────────────────────────────────────────

  async deniedFs(label: string, who: Who, ops: WriteOp[]): Promise<void> {
    const before = this.state();
    try {
      await applyFs(this.fs[who], ops);
      this.failures.push(`allowed: ${label}`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'permission-denied') this.failures.push(`${label}: failed with ${code} ${(e as Error).message}`);
    }
    if (this.state() !== before) this.failures.push(`changed state: ${label}`);
  }

  async allowedFs(label: string, who: Who, ops: WriteOp[]): Promise<boolean> {
    try {
      await applyFs(this.fs[who], ops);
      return true;
    } catch (e) {
      this.failures.push(`denied: ${label} (${(e as Error).message})`);
      return false;
    }
  }

  // ─── Realtime Database ─────────────────────────────────────────────

  /** Run a single-path write through `simulate` and record a disagreement with the sandbox. */
  private crossCheck(label: string, who: Who | Database, op: LiveOp, before: Data, allowed: boolean): void {
    if (typeof who !== 'string') return;
    let value: unknown;
    if (op.type === 'set') value = op.value;
    else if (Object.keys(op.value).every((k) => !k.includes('/')) && op.path.endsWith('/meta')) {
      // An update of one node's own children is a merge into that node.
      const at = op.path.split('/').reduce<unknown>((node, key) => (node as Data | undefined)?.[key], before) as Data | undefined;
      value = { ...(at ?? {}), ...op.value };
    } else return;
    const [result] = jsonRules.simulate([{
      expectation: allowed ? 'ALLOW' : 'DENY',
      operation: 'write',
      path: `/${op.path}`,
      auth: uidOf[who],
      data: before,
      newData: value,
    }]).cases;
    this.record(label, result, allowed);
  }

  /** Count a `simulate` verdict against the sandbox's; any difference is a disagreement. */
  private record(label: string, result: { passed: boolean; decision: string; reason: string }, allowed: boolean): void {
    this.simulated++;
    if (!result.passed) this.disagreements.push(`${label}: sandbox ${allowed ? 'ALLOW' : 'DENY'}, simulate ${result.decision} (${result.reason})`);
  }

  private db(who: Who | Database): Database {
    return typeof who === 'string' ? this.rtdb[who] : who;
  }

  async deniedLive(label: string, who: Who | Database, op: LiveOp): Promise<void> {
    const before = this.state();
    const tree = this.tree();
    try {
      await applyLive(this.db(who), op);
      this.failures.push(`allowed: ${label}`);
      this.crossCheck(label, who, op, tree, true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'PERMISSION_DENIED') this.failures.push(`${label}: failed with ${code} ${(e as Error).message}`);
      this.crossCheck(label, who, op, tree, false);
    }
    if (this.state() !== before) this.failures.push(`changed state: ${label}`);
  }

  private realWrites = 0;

  /** A real write: allowed. Every CROSS_CHECK_EVERY-th one is also run through `simulate`. */
  async allowedLive(label: string, who: Who | Database, op: LiveOp): Promise<boolean> {
    const check = this.realWrites++ % CROSS_CHECK_EVERY === 0;
    const tree = check ? this.tree() : {};
    try {
      await applyLive(this.db(who), op);
      if (check) this.crossCheck(label, who, op, tree, true);
      return true;
    } catch (e) {
      this.failures.push(`denied: ${label} (${(e as Error).message})`);
      this.crossCheck(label, who, op, tree, false);
      return false;
    }
  }

  async read(label: string, who: Who, path: string, expect: 'ALLOW' | 'DENY'): Promise<void> {
    const tree = this.tree();
    let allowed = true;
    try {
      await get(ref(this.rtdb[who], path));
    } catch {
      allowed = false;
    }
    if ((expect === 'ALLOW') !== allowed) this.failures.push(`read ${expect === 'ALLOW' ? 'denied' : 'allowed'}: ${label}`);
    const [result] = jsonRules.simulate([{ expectation: allowed ? 'ALLOW' : 'DENY', operation: 'read', path: `/${path}`, auth: uidOf[who], data: tree }]).cases;
    this.record(`read ${label}`, result, allowed);
  }

  put(rel: string, value: unknown): LiveOp {
    return { type: 'set', path: `${this.base}/${rel}`, value };
  }

  patch(value: Record<string, unknown>, rel = ''): LiveOp {
    return { type: 'update', path: rel ? `${this.base}/${rel}` : this.base, value };
  }

  // ─── Lobby ─────────────────────────────────────────────────────────

  async createAndJoin(withCheats: boolean): Promise<void> {
    const fresh = { ...createdMatch(airHockey, HOST), createdAt: FieldValue.serverTimestamp() } as Data;
    const create = (data: Data): WriteOp[] => [{ type: 'set', path: this.path, data }];
    if (withCheats) {
      await this.deniedFs('create with a goal scored', 'host', create({ ...fresh, score: { host: 1, guest: 0 } }));
      await this.deniedFs('create already ended', 'host', create({ ...fresh, endedBy: 'goals' }));
      await this.deniedFs('create with a winner', 'host', create({ ...fresh, winner: 'host' }));
      await this.deniedFs('create with the guest to move', 'host', create({ ...fresh, currentTurn: 'guest' }));
      await this.deniedFs('create with a move made', 'host', create({ ...fresh, moveCount: 1 }));
      await this.deniedFs('create playing', 'host', create({ ...fresh, status: 'playing' }));
      await this.deniedFs('create with an extra field', 'host', create({ ...fresh, puck: { x: 0, y: 0 } }));
      await this.deniedFs('create with a score field more', 'host', create({ ...fresh, score: { host: 0, guest: 0, ref: 0 } }));
      await this.deniedFs('create with a client clock', 'host', create({ ...fresh, createdAt: new Date(0) }));
      await this.deniedFs('create for someone else', 'host', create({ ...fresh, host: GUEST }));
      await this.deniedFs('create with the guest seated', 'host', create({ ...fresh, guest: GUEST }));
      await this.deniedFs('create by a stranger', 'stranger', create(fresh));
    }
    if (!(await this.allowedFs('create', 'host', create(fresh)))) return;
    const joined = joinedMatch(this.stored(), GUEST);
    const join = (data: Data): WriteOp[] => [{ type: 'update', path: this.path, data }];
    if (withCheats) {
      await this.deniedFs('the host joins their own match', 'host', join({ guest: HOST, status: 'playing' }));
      await this.deniedFs('join and score', 'guest', join({ guest: joined.guest, status: joined.status, score: { host: 0, guest: 1 } }));
      await this.deniedFs('join as someone else', 'guest', join({ guest: STRANGER, status: 'playing' }));
    }
    await this.allowedFs('join', 'guest', join({ guest: joined.guest, status: joined.status }));
    if (withCheats) {
      await this.deniedFs('join a full match', 'stranger', join({ guest: STRANGER }));
      for (const who of ['host', 'guest'] as const) {
        const before = this.state();
        try {
          await this.fs[who].doc(this.path).delete();
          this.failures.push(`allowed: the ${who} cancels a match in play`);
        } catch {
          // denied
        }
        if (this.state() !== before) this.failures.push(`changed state: the ${who} cancels a match in play`);
      }
    }
  }

  /** The host opens the live match; both players register presence and its disconnect write. */
  async startLive(world: World, withCheats: boolean): Promise<void> {
    const meta = startMetaOp(this.id, HOST, GUEST);
    const metaValue = (meta as { value: Data }).value;
    if (withCheats) {
      await this.read('the guest reads before the host opens the match', 'guest', this.base, 'DENY');
      await this.deniedLive('the guest opens the match', 'guest', meta);
      await this.deniedLive('a stranger opens the match at the host path', 'stranger', meta);
      await this.deniedLive('the host names itself the guest', 'host', this.put('meta', { ...metaValue, guest: HOST }));
      await this.deniedLive('the host names no guest', 'host', this.put('meta', { ...metaValue, guest: '' }));
      await this.deniedLive('the host opens the match already over', 'host', this.put('meta', { ...metaValue, status: 'over' }));
      await this.deniedLive('the host opens the match with a winner', 'host', this.put('meta', { ...metaValue, winner: 'host' }));
      await this.deniedLive('the host opens the match without a winner field', 'host', this.put('meta', { guest: GUEST, status: 'playing' }));
      await this.deniedLive('the host opens the match with an extra field', 'host', this.put('meta', { ...metaValue, startedAt: 0 }));
      await this.deniedLive('the host opens the match with a numeric guest', 'host', this.put('meta', { ...metaValue, guest: 7 }));
      await this.deniedLive('the host opens the match without a guest', 'host', this.put('meta', { status: 'playing', winner: '' }));
      await this.deniedLive('the host writes a frame before opening the match', 'host', startLiveOp(this.id, HOST, world));
    }
    if (!(await this.allowedLive('the host opens the match', 'host', meta))) return;
    const start = startLiveOp(this.id, HOST, world);
    if (withCheats) {
      await this.deniedLive('the host reopens the match for a stranger', 'host', this.put('meta', { ...metaValue, guest: STRANGER }));
      await this.deniedLive('the host swaps the guest', 'host', this.patch({ guest: STRANGER }, 'meta'));
      await this.deniedLive('the host deletes the match meta', 'host', this.put('meta', null));
      await this.deniedLive('the host starts at 1 to 0', 'host', this.patch({ ...start.value as Data, score: { host: 1, guest: 0 } }));
      {
        const first = (start.value as { frame: { puck: Data } }).frame;
        const { t: _t, ...untimed } = first.puck;
        await this.deniedLive('the host starts without a tick', 'host', this.patch({ ...start.value as Data, frame: { ...first, puck: untimed } }));
      }
      await this.deniedLive('the host starts at 0 to 1', 'host', this.patch({ ...start.value as Data, score: { host: 0, guest: 1 } }));
      await this.deniedLive('the host starts with a score field more', 'host', this.patch({ ...start.value as Data, score: { host: 0, guest: 0, bonus: 0 } }));
      await this.deniedLive('the guest writes the first frame', 'guest', start);
      await this.read('a stranger reads the match', 'stranger', this.base, 'DENY');
      await this.read('a stranger reads the meta', 'stranger', `${this.base}/meta`, 'DENY');
      await this.read('a stranger reads every match', 'stranger', 'airhockey', 'DENY');
    }
    await this.allowedLive('the host starts the match', 'host', start);
    await this.read('the host reads the match', 'host', this.base, 'ALLOW');
    await this.read('the guest reads the match', 'guest', this.base, 'ALLOW');
    for (const side of ['host', 'guest'] as const) {
      if (withCheats) {
        const other: Side = side === 'host' ? 'guest' : 'host';
        await this.deniedLive(`the ${other} marks the ${side} present`, other, presenceOp(this.id, HOST, side, true));
        await this.deniedLive(`a stranger marks the ${side} present`, 'stranger', presenceOp(this.id, HOST, side, true));
        await this.deniedLive(`the ${side} writes a presence that isn't a boolean`, side, presenceOp(this.id, HOST, side, 'yes' as unknown as boolean));
        await this.deniedLive(`the ${side} writes presence for a third seat`, side, { type: 'set', path: `${this.base}/presence/referee`, value: true });
        const before = this.state();
        try {
          await onDisconnect(ref(this.rtdb.stranger, presencePath(this.id, HOST, side))).set(false);
          this.failures.push(`allowed: a stranger registers the ${side}'s disconnect`);
        } catch {
          // denied at registration
        }
        if (this.state() !== before) this.failures.push(`changed state: a stranger registers the ${side}'s disconnect`);
      }
      await this.allowedLive(`the ${side} is present`, side, presenceOp(this.id, HOST, side, true));
      try {
        await onDisconnect(ref(this.rtdb[side], presencePath(this.id, HOST, side))).set(false);
      } catch (e) {
        this.failures.push(`denied: the ${side} registers its disconnect (${(e as Error).message})`);
      }
    }
  }
}

/** Cheats derived from a real host frame: each denied with nothing changed. */
async function frameCheats(m: Match, op: LiveOp, world: World, scored: boolean): Promise<void> {
  const frame = frameOf(world);
  const stored = m.live()!;
  const s = stored.score!;
  const { puck } = frame;
  // The real write with its frame changed: the same kind of write, one node or the goal update.
  const withFrame = (f: Data): LiveOp => op.type === 'set' ? m.put('frame', f) : m.patch({ ...op.value, frame: f });
  const withPuck = (p: Data) => withFrame({ ...frame, puck: { ...puck, ...p } });
  // The real frame sent with `score`, as a goal frame would be.
  const withScore = (score: unknown): LiveOp => m.patch({ ...(op.type === 'set' ? { frame } : op.value), score });

  await m.deniedLive('the guest sends the host frame', 'guest', op);
  await m.deniedLive('a stranger sends the host frame', 'stranger', op);
  await m.deniedLive('the guest writes the frame', 'guest', m.put('frame', frame));
  await m.deniedLive('the guest writes the puck', 'guest', m.put('frame/puck', puck));
  await m.deniedLive('the guest scores for itself', 'guest', m.put('score', { host: s.host, guest: s.guest + 1 }));
  await m.deniedLive('the guest writes the host mallet', 'guest', m.put('frame/host', frame.host));
  await m.deniedLive('the host writes the guest mallet', 'host', m.put('guestMallet', frame.guest));
  await m.deniedLive('the host frame also moves the guest mallet', 'host', m.patch({ frame, guestMallet: frame.guest }));
  await m.deniedLive('the puck left of the table', 'host', withPuck({ x: -1 }));
  await m.deniedLive('the puck right of the table', 'host', withPuck({ x: 96.5 }));
  await m.deniedLive('the puck above the table', 'host', withPuck({ y: -0.5 }));
  await m.deniedLive('the puck below the table', 'host', withPuck({ y: 128.5 }));
  await m.deniedLive('the puck faster than top speed on one axis', 'host', withPuck({ vx: 181, vy: 0 }));
  await m.deniedLive('the puck faster than top speed backwards', 'host', withPuck({ vx: 0, vy: -181 }));
  await m.deniedLive('the puck faster than top speed overall', 'host', withPuck({ vx: 130, vy: -130 }));
  await m.deniedLive('the puck position as a string', 'host', withPuck({ x: String(puck.x) }));
  await m.deniedLive('the puck tick as a string', 'host', withPuck({ t: String(puck.t) }));
  await m.deniedLive('the puck with a spin field', 'host', withPuck({ spin: 1 }));
  await m.deniedLive('the puck without a velocity', 'host', withFrame({ ...frame, puck: { x: puck.x, y: puck.y, t: puck.t } }));
  for (const field of ['x', 'y', 'vx', 'vy', 't'] as const) {
    const { [field]: _dropped, ...rest } = puck;
    await m.deniedLive(`the puck without ${field}`, 'host', withFrame({ ...frame, puck: rest }));
  }
  await m.deniedLive('the puck moved at the stored tick', 'host', withPuck({ x: puck.x === 48 ? 47 : 48, t: stored.frame!.puck.t }));
  await m.deniedLive('the puck moved at an earlier tick', 'host', withPuck({ t: stored.frame!.puck.t - 1 }));
  await m.deniedLive('the host mallet in the guest half', 'host', withFrame({ ...frame, host: { x: frame.host.x, y: 60 } }));
  await m.deniedLive('the host mallet past the side wall', 'host', withFrame({ ...frame, host: { x: 92, y: frame.host.y } }));
  await m.deniedLive('the host mallet past the near side wall', 'host', withFrame({ ...frame, host: { x: 4, y: frame.host.y } }));
  await m.deniedLive('the host mallet past the end wall', 'host', withFrame({ ...frame, host: { x: frame.host.x, y: 124 } }));
  await m.deniedLive('the host mallet as text', 'host', withFrame({ ...frame, host: { x: frame.host.x, y: String(frame.host.y) } }));
  await m.deniedLive('the host mallet with an extra field', 'host', withFrame({ ...frame, host: { ...frame.host, z: 1 } }));
  await m.deniedLive('the host mallet without y', 'host', withFrame({ ...frame, host: { x: frame.host.x } }));
  await m.deniedLive('the host mallet without x', 'host', withFrame({ ...frame, host: { y: frame.host.y } }));
  await m.deniedLive('the seen guest mallet in the host half', 'host', withFrame({ ...frame, guest: { x: frame.guest.x, y: 70 } }));
  await m.deniedLive('the seen guest mallet past the far end', 'host', withFrame({ ...frame, guest: { x: frame.guest.x, y: 4 } }));
  await m.deniedLive('the seen guest mallet past a side wall', 'host', withFrame({ ...frame, guest: { x: 92, y: frame.guest.y } }));
  await m.deniedLive('the seen guest mallet past the other side wall', 'host', withFrame({ ...frame, guest: { x: 4, y: frame.guest.y } }));
  await m.deniedLive('the seen guest mallet without x', 'host', withFrame({ ...frame, guest: { y: frame.guest.y } }));
  await m.deniedLive('the seen guest mallet without y', 'host', withFrame({ ...frame, guest: { x: frame.guest.x } }));
  await m.deniedLive('the frame without the seen guest mallet', 'host', withFrame({ puck, host: frame.host }));
  await m.deniedLive('the frame with an extra node', 'host', withFrame({ ...frame, ball: puck }));
  await m.deniedLive('a score jump of two', 'host', withScore({ host: s.host + 2, guest: s.guest }));
  await m.deniedLive('a score jump of two for the guest', 'host', withScore({ host: s.host, guest: s.guest + 2 }));
  await m.deniedLive('a goal for each side at once', 'host', withScore({ host: s.host + 1, guest: s.guest + 1 }));
  await m.deniedLive('a goal as a fraction', 'host', withScore({ host: s.host + 0.5, guest: s.guest }));
  if (s.guest > 0) await m.deniedLive('a guest goal taken back', 'host', withScore({ host: s.host, guest: s.guest - 1 }));
  if (s.host > 0) await m.deniedLive('a host goal taken back', 'host', withScore({ host: s.host - 1, guest: s.guest }));
  await m.deniedLive('a score with a third side', 'host', withScore({ ...s, ref: 0 }));
  await m.deniedLive('a score without the guest', 'host', withScore({ host: s.host + 1 }));
  await m.deniedLive('a score without the host', 'host', withScore({ guest: s.guest + 1 }));
  await m.deniedLive('the score as strings', 'host', withScore({ host: String(s.host + 1), guest: String(s.guest) }));
  await m.deniedLive('the host marks the guest gone', 'host', presenceOp(m.id, HOST, 'guest', false));
  await m.deniedLive('the guest marks the host gone', 'guest', presenceOp(m.id, HOST, 'host', false));
  await m.deniedLive('the host deletes the score', 'host', m.put('score', null));
  await m.deniedLive('the host deletes the frame', 'host', m.put('frame', null));
  await m.deniedLive('the host deletes its presence', 'host', m.put('presence/host', null));
  await m.deniedLive('the guest deletes the meta', 'guest', m.put('meta', null));
  await m.deniedLive('the host closes the match without 7 goals', 'host', m.patch({ status: 'over', winner: 'host' }, 'meta'));
  await m.deniedLive('the host closes the match for the guest without 7 goals', 'host', m.patch({ status: 'over', winner: 'guest' }, 'meta'));
  await m.deniedLive('the host forfeits the present guest', 'host', forfeitMetaOp(m.id, HOST, 'host'));
  await m.deniedLive('the guest forfeits the present host', 'guest', forfeitMetaOp(m.id, HOST, 'guest'));
  await m.deniedLive('the host resigns and names itself the winner', 'host', m.patch({ status: 'resigned', winner: 'host' }, 'meta'));
  await m.deniedLive('the guest resigns and names itself the winner', 'guest', m.patch({ status: 'resigned', winner: 'guest' }, 'meta'));
  await m.deniedLive('the guest closes the match', 'guest', m.patch({ status: 'over', winner: 'guest' }, 'meta'));
  await m.deniedLive('a stranger resigns the guest', 'stranger', resignMetaOp(m.id, HOST, 'guest'));
  await m.deniedLive('a stranger resigns the host', 'stranger', resignMetaOp(m.id, HOST, 'host'));
  await m.deniedLive('a draw', 'host', m.patch({ status: 'over', winner: 'draw' }, 'meta'));
  await m.deniedLive('an unknown end', 'host', m.patch({ status: 'abandoned', winner: 'guest' }, 'meta'));
  await m.deniedLive('meta with an extra field', 'host', m.patch({ note: 'x' }, 'meta'));
  await m.deniedLive('meta with a numeric status', 'host', m.patch({ status: 1 }, 'meta'));
  await m.deniedLive('the match still playing with a winner', 'host', m.patch({ winner: 'host' }, 'meta'));
  await m.deniedLive('the guest takes the host seat', 'guest', m.patch({ guest: HOST }, 'meta'));
  await m.deniedLive('the guest resigns and hands its seat to a stranger', 'guest', m.patch({ guest: STRANGER, status: 'resigned', winner: 'host' }, 'meta'));
  if (scored) {
    const credited = (op.value as Data).score as { host: number; guest: number };
    const scorer: Side = credited.host > s.host ? 'host' : 'guest';
    const other: Side = scorer === 'host' ? 'guest' : 'host';
    const won = winner(world.score);
    const value = op.value as Data;
    if (won) {
      const { ['meta/status']: _status, ['meta/winner']: _winner, ...open } = value;
      await m.deniedLive('the winning goal without closing the match', 'host', m.patch(open));
      await m.deniedLive('the winning goal naming the loser', 'host', m.patch({ ...value, 'meta/winner': other }));
      await m.deniedLive('the winning goal naming no winner', 'host', m.patch({ ...value, 'meta/winner': '' }));
      await m.deniedLive('the winning goal as a forfeit', 'host', m.patch({ ...value, 'meta/status': 'forfeit' }));
      await m.deniedLive('the winning goal as a resignation', 'host', m.patch({ ...value, 'meta/status': 'resigned', 'meta/winner': 'guest' }));
    } else {
      await m.deniedLive('a goal that closes the match early', 'host', m.patch({ ...value, 'meta/status': 'over', 'meta/winner': scorer }));
    }
  }
}

/** Cheats derived from a real guest mallet write. */
async function malletCheats(m: Match, p: Vec): Promise<void> {
  const real = malletOp(m.id, HOST, p);
  await m.deniedLive('a stranger moves the guest mallet', 'stranger', real);
  await m.deniedLive('the host moves the guest mallet', 'host', real);
  await m.deniedLive('the guest mallet in the host half', 'guest', m.put('guestMallet', { x: p.x, y: 70 }));
  await m.deniedLive('the guest mallet over the center line', 'guest', m.put('guestMallet', { x: p.x, y: 60 }));
  await m.deniedLive('the guest mallet past the side wall', 'guest', m.put('guestMallet', { x: -1, y: p.y }));
  await m.deniedLive('the guest mallet past the other side wall', 'guest', m.put('guestMallet', { x: 92, y: p.y }));
  await m.deniedLive('the guest mallet past the far end', 'guest', m.put('guestMallet', { x: p.x, y: MALLET_R - 1 }));
  await m.deniedLive('the guest mallet as text', 'guest', m.put('guestMallet', { x: String(p.x), y: p.y }));
  await m.deniedLive('the guest mallet y as text', 'guest', m.put('guestMallet', { x: p.x, y: String(p.y) }));
  await m.deniedLive('the guest mallet with a speed', 'guest', m.put('guestMallet', { ...p, vx: 100 }));
  await m.deniedLive('the guest mallet without x', 'guest', m.put('guestMallet', { y: p.y }));
  await m.deniedLive('the guest mallet without y', 'guest', m.put('guestMallet', { x: p.x }));
  await m.deniedLive('the guest deletes its mallet', 'guest', m.put('guestMallet', null));
}

interface PlayOptions {
  seed: number;
  /** Cheats before every goal and every `cheatEvery`-th frame and guest mallet; 0 for none. */
  cheatEvery: number;
  /** The world the stored live match is at. */
  start?: World;
  /** The guest parks here instead of playing. */
  guestAt?: Vec;
}

/** Play the live match to 7 goals from the stored state, cheats before the scheduled writes. */
async function playToSeven(m: Match, options: PlayOptions): Promise<{ world: World; frames: number }> {
  const { seed, cheatEvery } = options;
  const random = mulberry32(seed);
  let world = options.start ?? initialWorld();
  let frames = 0;
  let plan: Record<Side, Plan> = { host: { aim: 0, guard: 48 }, guest: { aim: 0, guard: 48 } };
  let guestTarget = world.guest;
  let scored = false;
  let mallets = 0;
  const cheatNow = (n: number) => cheatEvery > 0 && n % cheatEvery === 0;
  while (!winner(world.score) && world.tick < 60 * 60 * 10) {
    if (world.tick % 60 === 0) plan = {
      host: { aim: random() * 2 - 1, guard: random() < 0.5 ? 8 : 88 },
      guest: { aim: random() * 2 - 1, guard: random() < 0.5 ? 8 : 88 },
    };
    if (world.tick % WRITE_TICKS === 0) {
      // The guest writes its own mallet; the host simulates from the last one it received.
      guestTarget = clampMallet('guest', options.guestAt ?? autopilot('guest', world, plan.guest));
      const op = malletOp(m.id, HOST, guestTarget);
      if (cheatNow(mallets)) await malletCheats(m, frameOf({ ...world, guest: guestTarget }).guest);
      if (!(await m.allowedLive(`guest mallet at tick ${world.tick}`, 'guest', op))) break;
      mallets++;
    }
    const r = step(world, autopilot('host', world, plan.host), guestTarget);
    world = r.world;
    if (r.goal) scored = true;
    if (world.tick % WRITE_TICKS === 0 || r.goal) {
      const op = frameOp(m.id, HOST, world, scored);
      if (cheatEvery > 0 && (scored || cheatNow(frames))) await frameCheats(m, op, world, scored);
      if (!(await m.allowedLive(`frame at tick ${world.tick}${scored ? ` (goal, ${world.score.host} to ${world.score.guest})` : ''}`, 'host', op))) break;
      frames++;
      scored = false;
    }
  }
  if (!winner(world.score)) m.failures.push(`seed ${seed}: no winner by tick ${world.tick}`);
  return { world, frames };
}

/** Writes after the live match has ended: all denied. */
async function afterEnd(m: Match, world: World, label: string): Promise<void> {
  const next = { ...world, tick: world.tick + 3 };
  await m.deniedLive(`${label}: a host frame`, 'host', frameOp(m.id, HOST, next, false));
  await m.deniedLive(`${label}: a guest mallet`, 'guest', malletOp(m.id, HOST, malletHome('guest')));
  await m.deniedLive(`${label}: the host present again`, 'host', presenceOp(m.id, HOST, 'host', true));
  await m.deniedLive(`${label}: the guest present again`, 'guest', presenceOp(m.id, HOST, 'guest', true));
  await m.deniedLive(`${label}: the match reopened`, 'host', m.patch({ status: 'playing', winner: '' }, 'meta'));
  await m.deniedLive(`${label}: the host resigns`, 'host', resignMetaOp(m.id, HOST, 'host'));
  const s = m.live()?.score ?? { host: 0, guest: 0 };
  await m.deniedLive(`${label}: one more goal`, 'host', m.put('score', { host: s.host, guest: s.guest + 1 }));
}

/** Firestore result cheats before the host's real finish. */
async function finishCheats(m: Match, score: { host: number; guest: number }): Promise<void> {
  const won = winner(score)!;
  const lost: Side = won === 'host' ? 'guest' : 'host';
  const real = finishOps(m.id, score);
  const withData = (d: Data): WriteOp[] => [{ type: 'update', path: m.path, data: { ...(real[0] as { data: Data }).data, ...d } }];
  await m.deniedFs('the guest records the result', 'guest', real);
  await m.deniedFs('a stranger records the result', 'stranger', real);
  await m.deniedFs('the result names the loser', 'host', withData({ winner: lost }));
  await m.deniedFs('the result with both at 7', 'host', withData({ score: { ...score, [lost]: WIN_SCORE } }));
  await m.deniedFs('the result with no side at 7', 'host', withData({ score: { ...score, [won]: WIN_SCORE - 1 } }));
  await m.deniedFs('the result at 8', 'host', withData({ score: { ...score, [won]: WIN_SCORE + 1 } }));
  await m.deniedFs('the result with a negative score', 'host', withData({ score: { ...score, [lost]: -1 } }));
  await m.deniedFs('the result with a fractional score', 'host', withData({ score: { ...score, [lost]: 0.5 } }));
  await m.deniedFs('the result with a third side', 'host', withData({ score: { ...score, ref: 0 } }));
  await m.deniedFs('the result as a draw', 'host', withData({ status: 'draw', winner: '' }));
  await m.deniedFs('the result still playing', 'host', withData({ status: 'playing' }));
  await m.deniedFs('the result also swaps the guest', 'host', withData({ guest: STRANGER }));
  await m.deniedFs('the result as a forfeit at 7', 'host', withData({ endedBy: 'forfeit' }));
  await m.deniedFs('the result with an extra field', 'host', withData({ note: 'gg' }));
}

/**
 * Play one match to 7 and record its result. The late match is seeded at 6
 * to 6 with the puck served to the host and the guest parked in a corner, so
 * the host wins with its first shot; it runs the lobby and opening cheats and
 * cheats before every write. The full match (seed 36, which the guest wins)
 * runs cheats at every goal and every CHEAT_EVERY-th write, then records a
 * final score that isn't the live one, which the rules allow and the clients
 * flag.
 */
async function playMatch(late: boolean): Promise<Match> {
  const m = new Match(late ? 'late' : 'full');
  await m.createAndJoin(late);
  await m.startLive(initialWorld(), late);
  let start: World | undefined;
  if (late) {
    start = { ...initialWorld(), puck: servedPuck('host'), guest: { x: 8, y: 16 }, score: { host: 6, guest: 6 }, tick: 3000 };
    // setData replaces the whole tree, so it gets the whole tree back with the seeded match.
    const tree = m.tree() as { airhockey: Record<string, Record<string, Data>> };
    tree.airhockey[m.id][HOST] = { ...tree.airhockey[m.id][HOST], frame: frameOf(start), score: start.score };
    rtdbSandbox.setData(m.admin, { '/': tree as unknown as Data });
    m.sandbox.admin.setDocument(m.path, { ...m.stored(), score: start.score });
  }
  const { world, frames } = await playToSeven(m, late
    ? { seed: 1, cheatEvery: 1, start, guestAt: { x: 8, y: 16 } }
    : { seed: 36, cheatEvery: CHEAT_EVERY });
  const label = late ? 'late match' : 'full match';
  if (!winner(world.score)) return m;
  const live = m.live();
  if (live?.meta?.status !== 'over' || live.meta.winner !== winner(world.score)) m.failures.push(`${label}: live match not closed (${JSON.stringify(live?.meta)})`);
  if (JSON.stringify(live?.score) !== JSON.stringify(world.score)) m.failures.push(`${label}: live score ${JSON.stringify(live?.score)} is not ${JSON.stringify(world.score)}`);
  await afterEnd(m, world, `${label} after 7 goals`);
  await finishCheats(m, world.score);
  if (late) {
    await m.allowedFs('the host records the result', 'host', finishOps(m.id, world.score));
    if (!resultMatchesLive(m.stored(), m.live())) m.failures.push('the real result was flagged');
  } else {
    // A result with a legal shape but not the live score: the rules can't tell, the clients can.
    const other = winner(world.score) === 'host' ? 'guest' : 'host';
    const forged = { ...world.score, [other]: world.score[other] === 0 ? 1 : 0 };
    await m.allowedFs('the host records a score that is not the live one (rules cannot read the live match)', 'host', finishOps(m.id, forged));
    if (resultMatchesLive(m.stored(), m.live())) m.failures.push('a forged final score was not flagged');
  }
  await m.deniedFs('a forfeit after the result', 'guest', forfeitOps(m.id, 'guest', { host: 0, guest: 0 }));
  await m.deniedFs('resign after the result', 'guest', [{ type: 'update', path: m.path, data: { status: 'resigned', winner: 'host' } }]);
  console.log(`${label}: ${world.score.host} to ${world.score.guest} at tick ${world.tick}, ${frames} frames; `
    + `simulate agreed with the sandbox on ${m.simulated - m.disagreements.length} of ${m.simulated} cases`);
  return m;
}

describe('Air Hockey Security Rules', () => {
  test('database.rules.json is generated from the TypeScript rules', () => {
    expect(databaseRulesText).toBe(renderRules());
  });

  test('a late match the host wins 7 to 6: every real write allowed, cheats before every write, the result recorded', async () => {
    const m = await playMatch(true);
    expect(m.failures.slice(0, 40)).toEqual([]);
    expect(m.disagreements.slice(0, 20)).toEqual([]);
  }, 120_000);

  test('a full match to 7: every real write allowed, cheats at every goal and every 250th write, a forged final score flagged', async () => {
    const m = await playMatch(false);
    expect(m.failures.slice(0, 40)).toEqual([]);
    expect(m.disagreements.slice(0, 20)).toEqual([]);
  }, 300_000);

  test('a player who leaves forfeits; a forfeit while they are present is denied live and flagged', async () => {
    for (const leaver of ['guest', 'host'] as const) {
      const stayer: Side = leaver === 'host' ? 'guest' : 'host';
      const m = new Match(`forfeit-${leaver}`);
      await m.createAndJoin(false);
      await m.startLive(initialWorld(), false);
      let world = initialWorld();
      for (let i = 0; i < 9; i++) world = step(world, { x: 40, y: 100 }, { x: 50, y: 20 }).world;
      await m.allowedLive('a frame', 'host', frameOp(m.id, HOST, world, false));
      const score = m.live()!.score!;
      // The stayer claims the match while the leaver is still present: the live rules deny it.
      await m.deniedLive(`the ${stayer} forfeits the present ${leaver}`, stayer, forfeitMetaOp(m.id, HOST, stayer));
      await m.deniedFs(`the ${stayer} forfeits for the ${leaver}`, stayer, forfeitOps(m.id, leaver, score));
      await m.deniedFs(`a stranger records a forfeit`, 'stranger', forfeitOps(m.id, stayer, score));
      await m.deniedFs(`the ${stayer} forfeits with a side at 7`, stayer, forfeitOps(m.id, stayer, { host: 7, guest: 0 }));
      await m.deniedFs(`the ${stayer} forfeits as a result on goals`, stayer, [{ type: 'update', path: m.path, data: { ...(forfeitOps(m.id, stayer, score)[0] as { data: Data }).data, endedBy: 'goals' } }]);
      // The leaver closes the tab: its disconnect write marks it gone.
      goOffline(m.rtdb[leaver]);
      await Bun.sleep(20);
      if (m.live()?.presence?.[leaver] !== false) m.failures.push(`the ${leaver}'s disconnect did not mark it gone: ${JSON.stringify(m.live()?.presence)}`);
      await m.deniedLive(`the ${leaver} forfeits the present ${stayer}`, m.dbFor(uidOf[leaver]), forfeitMetaOp(m.id, HOST, leaver));
      await m.deniedLive(`the ${leaver} records its own forfeit`, m.dbFor(uidOf[leaver]), forfeitMetaOp(m.id, HOST, stayer));
      await m.deniedLive(`the ${stayer} forfeits naming the ${leaver} the winner`, stayer, m.patch({ status: 'forfeit', winner: leaver }, 'meta'));
      await m.deniedLive(`the ${stayer} closes the match as over while the ${leaver} is gone`, stayer, m.patch({ status: 'over', winner: stayer }, 'meta'));
      await m.deniedLive(`the ${stayer} names itself the winner and plays on while the ${leaver} is gone`, stayer, m.patch({ winner: stayer }, 'meta'));
      await m.deniedLive(`the ${stayer} records the ${leaver}'s resignation while it is gone`, stayer, m.patch({ status: 'resigned', winner: stayer }, 'meta'));
      const forfeitData = (forfeitOps(m.id, stayer, score)[0] as { data: Data }).data;
      await m.deniedFs(`the ${stayer} forfeits and keeps the match playing`, stayer, [{ type: 'update', path: m.path, data: { ...forfeitData, status: 'playing' } }]);
      await m.deniedFs(`the ${stayer} forfeits as a draw`, stayer, [{ type: 'update', path: m.path, data: { ...forfeitData, status: 'draw' } }]);
      await m.deniedFs(`the ${stayer} forfeits and swaps the ${leaver}`, stayer, [{ type: 'update', path: m.path, data: { ...forfeitData, [leaver]: STRANGER } }]);
      await m.allowedLive(`the ${stayer} claims the forfeit`, stayer, forfeitMetaOp(m.id, HOST, stayer));
      await m.allowedFs(`the ${stayer} records the forfeit`, stayer, forfeitOps(m.id, stayer, score));
      if (!resultMatchesLive(m.stored(), m.live())) m.failures.push('a real forfeit was flagged');
      await afterEnd(m, world, `after the ${leaver} forfeited`);
      expect(m.failures).toEqual([]);
      expect(m.disagreements).toEqual([]);
    }
  }, 60_000);

  test('a Firestore forfeit while the other player is present is allowed by the rules and flagged', async () => {
    const m = new Match('forged-forfeit');
    await m.createAndJoin(false);
    await m.startLive(initialWorld(), false);
    await m.allowedFs('the host records a forfeit with the guest present (Firestore rules cannot read presence)', 'host', forfeitOps(m.id, 'host', { host: 0, guest: 0 }));
    if (resultMatchesLive(m.stored(), m.live())) m.failures.push('a forged forfeit was not flagged');
    expect(m.failures).toEqual([]);
  }, 30_000);

  test('resign, and cancel a waiting match', async () => {
    const m = new Match('resign');
    await m.createAndJoin(false);
    await m.startLive(initialWorld(), false);
    const resign = (data: Data): WriteOp[] => [{ type: 'update', path: m.path, data }];
    await m.deniedFs('a stranger resigns the match', 'stranger', resign({ status: 'resigned', winner: 'host' }));
    await m.deniedFs('the guest resigns for the host', 'guest', resign({ status: 'resigned', winner: 'guest' }));
    await m.deniedFs('the guest resigns and changes the score', 'guest', resign({ status: 'resigned', winner: 'host', score: { host: 3, guest: 0 } }));
    await m.deniedFs('the guest concedes as a win instead of a resignation', 'guest', resign({ status: 'won', winner: 'host' }));
    await m.deniedFs('the guest names the host the winner and plays on', 'guest', resign({ winner: 'host' }));
    await m.deniedFs('the guest resigns as a draw', 'guest', resign({ status: 'draw', winner: 'host' }));
    await m.allowedFs('the guest resigns', 'guest', resign({ status: 'resigned', winner: 'host' }));
    await m.allowedLive('the guest resigns the live match', 'guest', resignMetaOp(m.id, HOST, 'guest'));
    await afterEnd(m, initialWorld(), 'after resigning');

    const h = new Match('resign-host');
    await h.createAndJoin(false);
    await h.startLive(initialWorld(), false);
    await h.allowedFs('the host resigns', 'host', [{ type: 'update', path: h.path, data: { status: 'resigned', winner: 'guest' } }]);
    await h.allowedLive('the host resigns the live match', 'host', resignMetaOp(h.id, HOST, 'host'));
    m.failures.push(...h.failures);
    m.disagreements.push(...h.disagreements);

    const k = new Match('cancel');
    await k.allowedFs('create', 'host', [{ type: 'set', path: k.path, data: { ...createdMatch(airHockey, HOST), createdAt: FieldValue.serverTimestamp() } }]);
    await k.deniedFs('finish a waiting match', 'host', finishOps(k.id, { host: 7, guest: 0 }));
    await k.deniedFs('forfeit a waiting match', 'host', forfeitOps(k.id, 'host', { host: 0, guest: 0 }));
    for (const who of ['stranger', 'guest'] as const) {
      try {
        await k.fs[who].doc(k.path).delete();
        k.failures.push(`allowed: the ${who} cancels`);
      } catch {
        // denied
      }
    }
    try {
      await k.fs.host.doc(k.path).delete();
    } catch (e) {
      k.failures.push(`denied: the host cancels a waiting match (${(e as Error).message})`);
    }
    if (k.stored()) k.failures.push('the cancelled match is still there');
    expect([...m.failures, ...k.failures]).toEqual([]);
    expect([...m.disagreements, ...k.disagreements]).toEqual([]);
  }, 30_000);
});
