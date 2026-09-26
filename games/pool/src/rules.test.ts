/**
 * Pool Security Rules against Pyric's sandbox. Seeded matches play random
 * shots through the same update the browser writes; every real shot must be
 * allowed, and before each one a set of cheats derived from it must be denied
 * and leave the match unchanged. End-game positions are seeded directly to
 * check who the 8 makes the winner.
 *
 * The rules can't check physics: a result that is consistent but didn't come
 * from the shot is allowed. The replay check (`verifyShot`) must catch it.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { mulberry32 } from '@games/harness';
import { createdMatch, joinedMatch } from '@games/turn-net/transitions';
import { COLLECTION, SOLIDS, STRIPES, groupBalls, groupOf, pool, shotUpdate, takeShot, verifyShot, type PoolDoc } from './logic.ts';
import { OFF_TABLE, RACK, type Shot } from './physics.ts';

const rules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();

type Db = ReturnType<typeof getFirestore>;
type Data = Record<string, unknown>;

async function denied(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return false;
  } catch (e) {
    return (e as { code?: string }).code === 'permission-denied';
  }
}

function setup(seed: number) {
  const sandbox = initializeSandbox();
  const admin = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
  admin.setRules(rules);
  const host = getFirestore(sandbox.withAuth({ uid: 'host-uid' }));
  const guest = getFirestore(sandbox.withAuth({ uid: 'guest-uid' }));
  const stranger = getFirestore(sandbox.withAuth({ uid: 'stranger-uid' }));
  const path = `${COLLECTION}/m${seed}`;
  const failures: string[] = [];
  const stored = () => sandbox.admin.getDocument(path) as PoolDoc;
  const expectDenied = async (label: string, db: Db, write: (db: Db) => Promise<unknown>) => {
    const before = JSON.stringify(sandbox.admin.getDocument(path));
    if (!(await denied(() => write(db)))) failures.push(`allowed: ${label}`);
    if (JSON.stringify(sandbox.admin.getDocument(path)) !== before) failures.push(`changed state: ${label}`);
  };
  const expectAllowed = async (label: string, db: Db, write: (db: Db) => Promise<unknown>) => {
    try {
      await write(db);
      return true;
    } catch (e) {
      failures.push(`denied: ${label} (${(e as Error).message})`);
      return false;
    }
  };
  const update = (data: Data) => (db: Db) => db.doc(path).update(data);
  return { sandbox, host, guest, stranger, path, failures, stored, expectDenied, expectAllowed, update };
}

type Env = ReturnType<typeof setup>;

async function createAndJoin(env: Env): Promise<void> {
  const { host, guest, stranger, path, expectDenied, expectAllowed } = env;
  const fresh = { ...createdMatch(pool, 'host-uid'), createdAt: FieldValue.serverTimestamp() };
  const create = (data: Data) => (db: Db) => db.doc(path).set(data);
  await expectDenied('create with a ball already pocketed', host, create({ ...fresh, potted: [3] }));
  await expectDenied('create with a ball moved off the rack', host, create({ ...fresh, balls: RACK.map((v, i) => (i === 16 ? v - 500 : v)) }));
  await expectDenied('create with a group already taken', host, create({ ...fresh, hostGroup: 'solids' }));
  await expectDenied('create with the guest seated', host, create({ ...fresh, guest: 'guest-uid', status: 'playing' }));
  await expectDenied('create for someone else', stranger, create(fresh));
  await expectDenied('create with an extra field', host, create({ ...fresh, extra: 1 }));
  await expectDenied('create with a move already made', host, create({ ...fresh, moveCount: 1 }));
  await expectDenied('create with a winner', host, create({ ...fresh, winner: 'host' }));
  await expectDenied('create with a client clock', host, create({ ...fresh, createdAt: new Date(0) }));
  await expectDenied('create with a moved previous table', host, create({ ...fresh, prevBalls: RACK.map((v, i) => (i === 0 ? v + 1 : v)) }));
  await expectDenied('create with a previous pocketed ball', host, create({ ...fresh, prevPotted: [3] }));
  await expectDenied('create with a shot already taken', host, create({ ...fresh, shot: { dx: 1000, dy: 0, power: 50 } }));
  await expectDenied('create with a scratch', host, create({ ...fresh, scratch: true }));
  await expectDenied('create as the second shooter', host, create({ ...fresh, currentTurn: 'guest' }));
  await expectAllowed('create', host, create(fresh));
  const joined = joinedMatch(env.stored(), 'guest-uid');
  await expectDenied('host joins their own match', host, env.update({ guest: 'host-uid', status: 'playing' }));
  await expectDenied('join and move a ball', guest, env.update({ guest: joined.guest, status: joined.status, balls: RACK.map((v, i) => (i === 20 ? v + 300 : v)) }));
  await expectAllowed('join', guest, env.update({ guest: joined.guest, status: joined.status }));
  await expectDenied('join a full match', stranger, env.update({ guest: 'stranger-uid' }));
}

const other = (seat: 'host' | 'guest') => (seat === 'host' ? 'guest' : 'host');

/** Cheats derived from the real update for this shot. */
async function shotCheats(env: Env, doc: PoolDoc, real: Data, shooter: Db, watcher: Db): Promise<void> {
  const { expectDenied, update, stranger } = env;
  const seat = doc.currentTurn;
  await expectDenied('shoot out of turn', watcher, update(real));
  await expectDenied('a stranger shoots', stranger, update(real));
  if (doc.potted.length > 0) {
    await expectDenied('take a pocketed ball back', shooter, update({ ...real, potted: (real.potted as number[]).slice(1) }));
    if (doc.potted.length >= 2) {
      const potted = real.potted as number[];
      await expectDenied('trade a pocketed ball for a repeat of another', shooter, update({ ...real, potted: [potted[0], potted[0], ...potted.slice(2)] }));
    }
    await expectDenied('pocket a ball twice', shooter, update({ ...real, potted: [...(real.potted as number[]), doc.potted[0]] }));
  }
  await expectDenied('rewrite the table before the shot', shooter, update({ ...real, prevBalls: doc.balls.map((v, i) => (i === 0 ? v + 1 : v)) }));
  await expectDenied('rewrite the pocketed list before the shot', shooter, update({ ...real, prevPotted: [...doc.potted, 99] }));
  await expectDenied('shoot again after the turn passed, or pass after earning another shot', shooter, update({ ...real, currentTurn: real.currentTurn === seat ? other(seat) : seat }));
  const group = real.hostGroup as string;
  await expectDenied('take the other group', shooter, update({ ...real, hostGroup: group === 'solids' ? 'stripes' : 'solids' }));
  if (group !== '') await expectDenied('give up a taken group', shooter, update({ ...real, hostGroup: '' }));
  await expectDenied('claim the win without the 8', shooter, update({ ...real, status: 'won', winner: seat }));
  if (!doc.potted.includes(8) && !(real.potted as number[]).includes(8)) {
    if (real.status === 'playing') {
      await expectDenied('name a winner while play goes on', shooter, update({ ...real, winner: seat }));
      await expectDenied('end the match without the 8', shooter, update({ ...real, status: 'won', winner: other(seat), currentTurn: other(seat) }));
    }
    await expectDenied('pocket the 8 and play on', shooter, update({
      ...real, potted: [...(real.potted as number[]), 8], status: 'playing', winner: '', currentTurn: other(seat),
    }));
    await expectDenied('pocket the 8 early and claim the win', shooter, update({
      ...real, potted: [...(real.potted as number[]), 8], status: 'won', winner: seat, currentTurn: other(seat),
    }));
  }
  const shot = real.shot as Shot;
  await expectDenied('shoot with no power', shooter, update({ ...real, shot: { ...shot, power: 0 } }));
  await expectDenied('shoot harder than full power', shooter, update({ ...real, shot: { ...shot, power: 101 } }));
  await expectDenied('shoot with no direction', shooter, update({ ...real, shot: { dx: 0, dy: 0, power: shot.power } }));
  await expectDenied('pocket a ball that does not exist', shooter, update({ ...real, potted: [...(real.potted as number[]), 16] }));
  await expectDenied('aim with a fractional x', shooter, update({ ...real, shot: { ...shot, dx: shot.dx + 0.5 } }));
  await expectDenied('aim with a fractional y', shooter, update({ ...real, shot: { ...shot, dy: shot.dy + 0.5 } }));
  await expectDenied('aim past the x range', shooter, update({ ...real, shot: { ...shot, dx: 1001 } }));
  await expectDenied('aim past the y range', shooter, update({ ...real, shot: { ...shot, dy: -1001 } }));
  await expectDenied('aim past the top of the y range', shooter, update({ ...real, shot: { ...shot, dy: 1001 } }));
  await expectDenied('aim past the bottom of the x range', shooter, update({ ...real, shot: { ...shot, dx: -1001 } }));
  await expectDenied('shoot with a fractional power', shooter, update({ ...real, shot: { ...shot, power: 50.5 } }));
  await expectDenied('shoot with an extra shot field', shooter, update({ ...real, shot: { ...shot, spin: 3 } }));
  await expectDenied('skip a move number', shooter, update({ ...real, moveCount: doc.moveCount + 2 }));
  await expectDenied('add a field', shooter, update({ ...real, extra: true }));
  await expectDenied('replace the opponent', shooter, update({ ...real, [other(seat)]: 'stranger-uid' }));
  await expectDenied('report a scratch that is not a boolean', shooter, update({ ...real, scratch: 'no' }));
  await expectDenied('store the table as a string', shooter, update({ ...real, balls: 'x'.repeat(32) }));
  await expectDenied('drop balls from the table list', shooter, update({ ...real, balls: (real.balls as number[]).slice(2) }));
}

/**
 * A result consistent with the rules but not with the physics: one more ball
 * of the shooter's group (or any ball on an open table) goes down.
 */
function forgedResult(doc: PoolDoc, real: ReturnType<typeof takeShot>) {
  const mine = groupOf(doc.currentTurn, doc.hostGroup);
  const candidates = (mine === '' ? [...SOLIDS, ...STRIPES] : groupBalls(mine))
    .filter((n) => real.update.balls[n * 2] !== OFF_TABLE);
  const extra = candidates[0];
  if (extra === undefined) return null;
  const balls = real.update.balls.slice();
  balls[extra * 2] = OFF_TABLE;
  balls[extra * 2 + 1] = OFF_TABLE;
  return shotUpdate(doc, real.update.shot, { balls, scratch: real.result.scratch, newlyPotted: [...real.result.newlyPotted, extra] });
}

async function playMatch(seed: number, maxShots: number): Promise<{ shots: number; failures: string[]; forgedCaught: boolean }> {
  const env = setup(seed);
  const random = mulberry32(seed);
  await createAndJoin(env);
  const dbFor = { host: env.host, guest: env.guest };
  let shots = 0;
  let forgedCaught = false;
  while (shots < maxShots && env.stored().status === 'playing') {
    const doc = env.stored();
    const seat = doc.currentTurn;
    const angle = random() * Math.PI * 2;
    const scale = 1000 / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
    const shot: Shot = { dx: Math.round(Math.cos(angle) * scale), dy: Math.round(Math.sin(angle) * scale), power: 20 + Math.floor(random() * 81) };
    const real = takeShot(doc, shot);
    const data = { ...real.update } as Data;
    await shotCheats(env, doc, data, dbFor[seat], dbFor[other(seat)]);

    if (shots === 3 && !forgedCaught) {
      const forged = forgedResult(doc, real);
      if (forged && forged.status === 'playing') {
        if (!(await env.expectAllowed('a consistent forged result (rules cannot see physics)', dbFor[seat], env.update({ ...forged })))) break;
        if (verifyShot(env.stored()).ok) env.failures.push('replay missed a forged result');
        else forgedCaught = true;
        shots++;
        continue;
      }
    }
    if (!(await env.expectAllowed(`shot ${shots + 1}`, dbFor[seat], env.update(data)))) break;
    const after = env.stored();
    if (!verifyShot(after).ok) env.failures.push(`shot ${shots + 1}: replay disagrees with a real result`);
    for (const key of ['currentTurn', 'hostGroup', 'status', 'winner', 'moveCount'] as const) {
      if (after[key] !== data[key]) env.failures.push(`shot ${shots + 1}: stored ${key} ${String(after[key])}, expected ${String(data[key])}`);
    }
    shots++;
  }
  return { shots, failures: env.failures, forgedCaught };
}

/** Seed a position where `seat` is to shoot, then check who pocketing the 8 makes the winner. */
async function endGame(seed: number): Promise<string[]> {
  const env = setup(seed);
  await createAndJoin(env);
  const base = env.stored();
  const dbFor = { host: env.host, guest: env.guest };
  const seedPosition = (seat: 'host' | 'guest', potted: number[]) => {
    const balls = RACK.slice();
    for (const n of potted) {
      balls[n * 2] = OFF_TABLE;
      balls[n * 2 + 1] = OFF_TABLE;
    }
    const doc = { ...base, currentTurn: seat, hostGroup: 'solids', potted, balls, prevBalls: balls, prevPotted: potted, moveCount: 20 } as PoolDoc;
    env.sandbox.admin.setDocument(env.path, doc as unknown as Data);
    return doc;
  };
  const eight = (doc: PoolDoc, scratch: boolean) => {
    const balls = doc.balls.slice();
    balls[16] = OFF_TABLE;
    balls[17] = OFF_TABLE;
    return shotUpdate(doc, { dx: 1000, dy: 0, power: 50 }, { balls, scratch, newlyPotted: [8] });
  };
  const cases: Array<[string, 'host' | 'guest', number[], boolean, 'host' | 'guest', boolean]> = [
    ['host pockets the 8 after clearing solids', 'host', SOLIDS, false, 'host', true],
    ['host pockets the 8 after clearing solids and claims a loss', 'host', SOLIDS, false, 'guest', false],
    ['host scratches on the 8 and claims the win', 'host', SOLIDS, true, 'host', false],
    ['host scratches on the 8 and loses', 'host', SOLIDS, true, 'guest', true],
    ['host pockets the 8 with a solid left and claims the win', 'host', SOLIDS.slice(1), false, 'host', false],
    ['host pockets the 8 with a solid left and loses', 'host', SOLIDS.slice(1), false, 'guest', true],
    ['guest pockets the 8 after clearing stripes', 'guest', [...SOLIDS.slice(2), ...STRIPES], false, 'guest', true],
    ['guest pockets the 8 with only solids gone and claims the win', 'guest', SOLIDS, false, 'guest', false],
  ];
  for (const [label, seat, potted, scratch, winner, allowed] of cases) {
    const doc = seedPosition(seat, potted);
    const data = { ...eight(doc, scratch), winner } as Data;
    if (allowed) await env.expectAllowed(label, dbFor[seat], env.update(data));
    else await env.expectDenied(label, dbFor[seat], env.update(data));
  }
  // Pocketing the last solid with the 8 ends the game and passes the turn, though a solid alone would keep it.
  const last = seedPosition('host', SOLIDS.slice(1));
  const both = last.balls.slice();
  for (const n of [SOLIDS[0], 8]) {
    both[n * 2] = OFF_TABLE;
    both[n * 2 + 1] = OFF_TABLE;
  }
  const lastAndEight = { ...shotUpdate(last, { dx: 1000, dy: 0, power: 50 }, { balls: both, scratch: false, newlyPotted: [SOLIDS[0], 8] }), winner: 'guest' } as Data;
  await env.expectDenied('host pockets the last solid with the 8 and keeps the turn', env.host, env.update({ ...lastAndEight, currentTurn: 'host' }));
  await env.expectAllowed('host pockets the last solid with the 8 and loses', env.host, env.update(lastAndEight));
  const doc = seedPosition('host', SOLIDS);
  const quiet = shotUpdate(doc, { dx: 1000, dy: 0, power: 50 }, { balls: doc.balls, scratch: false, newlyPotted: [] });
  await env.expectDenied('host clears solids and claims the win without the 8', env.host, env.update({ ...quiet, status: 'won', winner: 'host' }));
  await env.expectDenied('a stranger resigns the match', env.stranger, env.update({ status: 'resigned', winner: 'host' }));
  await env.expectDenied('guest resigns for the host', env.guest, env.update({ status: 'resigned', winner: 'guest' }));
  await env.expectAllowed('host resigns', env.host, env.update({ status: 'resigned', winner: 'guest' }));
  await env.expectDenied('shoot after the match ended', env.guest, env.update({ ...eight({ ...doc, status: 'playing' } as PoolDoc, false) }));
  return env.failures;
}

describe('Pool Security Rules', () => {
  test('real shots allowed, every cheat denied, forged results caught by replay', async () => {
    const results = [];
    // Seed 9 has two balls down by its second shot, which the ball-trading cheat needs.
    for (const seed of [1, 3, 9]) results.push(await playMatch(seed, 25));
    const failures = results.flatMap((r, i) => r.failures.map((f) => `seed ${i + 1}: ${f}`));
    expect(failures.slice(0, 20)).toEqual([]);
    // A random shot can pocket the 8 and end a match early, so count shots across matches.
    expect(results.reduce((sum, r) => sum + r.shots, 0)).toBeGreaterThan(30);
    expect(results.some((r) => r.forgedCaught)).toBe(true);
  }, 60_000);

  test('the 8 decides the winner', async () => {
    expect(await endGame(9)).toEqual([]);
  }, 60_000);
});

test('physics replays exactly', () => {
  const doc = { balls: [...RACK], potted: [] as number[] };
  const shot = { dx: 1000, dy: 17, power: 100 };
  const a = takeShot({ ...createdMatch(pool, 'h'), ...doc } as PoolDoc, shot);
  const b = takeShot({ ...createdMatch(pool, 'h'), ...doc } as PoolDoc, shot);
  expect(a.update.balls).toEqual(b.update.balls);
});
