/**
 * Sokoban's Firestore and Storage rules against Pyric's sandbox, as the
 * acting user, through the same write lists the browser sends (solveWrites:
 * the score document, then the move-list object). Every real solve's score
 * and upload must be allowed; every cheat must be denied and leave both the
 * documents and the objects unchanged. The Storage rules read the score
 * document with firestore.get(), so the upload cases exercise the
 * cross-service check both ways: an upload with no score, and a score that
 * names another object.
 *
 * The rules can't replay a move list: a well-formed score and upload whose
 * moves don't solve the level is allowed, and verifyEntry must flag it.
 *
 * Removal probes (.overnight/probe-sokoban.ts, tools/removal-probe.ts): 36
 * probes, each a check removed or a missing grant added (delete or update of
 * a score, update or delete of an object).
 *   Firestore, 23: 21 caught. The 2 not caught are implied:
 *   - `request.auth != null` in sokobanScore: the next check reads
 *     request.auth.uid, which errors without auth, so the rule denies.
 *   - `level in sokobanLevels()`: `sokobanLevels()[level]` is read for the
 *     count minimums, and a level the map doesn't have errors there.
 *   Storage, 13: 11 caught. The 2 not caught are implied:
 *   - `request.auth != null` in sokobanUpload: request.auth.uid errors
 *     without auth, as above.
 *   - `request.resource.size <= 2000`: the size must equal the score's move
 *     count, which the Firestore rules cap at 2,000. It stays as the bound
 *     that holds on its own if the score check ever changes.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { deleteObject, getBytes, getMetadata, getStorageSandbox, listAll, ref, updateMetadata, uploadString, type FirebaseStorage } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { LEVELS } from './levels.ts';
import { replay } from './sokoban.ts';
import { SOLUTIONS as FOUND } from './solutions.ts';
import { levelById, objectPath, scorePath, solveWrites, verifyEntry, type ScoreFields, type SolveWrites, type Upload } from './logic.ts';

const firestoreRules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();
const storageRules = await Bun.file(new URL('../../../app/storage.rules', import.meta.url)).text();

type Data = Record<string, unknown>;
type Db = ReturnType<typeof getFirestore>;

const SOLUTIONS = new Map(Object.entries(FOUND));

/** A longer honest solution: a walk out and back at the first place one fits. */
function detour(level: string): string {
  const best = SOLUTIONS.get(level)!;
  for (let i = 0; i <= best.length; i++) {
    for (const pair of ['lr', 'rl', 'ud', 'du']) {
      const longer = best.slice(0, i) + pair + best.slice(i);
      if (replay(levelById(level)!, longer).ok) return longer;
    }
  }
  throw new Error(`no detour on level ${level}`);
}

let nextSolve = 0;
/** A 20-character solve id, as Firestore's auto ids are. */
const solveId = () => `Solve${String(nextSolve++).padStart(15, '0')}`;

class World {
  readonly sandbox = initializeSandbox();
  readonly failures: string[] = [];
  private readonly storages = new Map<string, FirebaseStorage>();
  private readonly admin: FirebaseStorage;

  constructor() {
    getFirestore(this.sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(firestoreRules);
    // Rules are honored on the first storage call per sandbox.
    this.storage('first-uid');
    this.admin = getAdminStorageSandbox(this.sandbox);
  }

  db(uid: string | null): Db {
    return getFirestore(this.sandbox.withAuth(uid === null ? (null as never) : { uid }));
  }

  storage(uid: string | null): FirebaseStorage {
    const key = uid ?? '';
    let s = this.storages.get(key);
    if (!s) {
      const ctx = this.sandbox.withAuth(uid === null ? (null as never) : { uid });
      s = getStorageSandbox(ctx, { rules: storageRules, dbName: `sokoban-rules-${crypto.randomUUID()}` });
      this.storages.set(key, s);
    }
    return s;
  }

  /** Every score document and every object with its bytes and metadata. */
  async snapshot(): Promise<string> {
    const docs = LEVELS.map((l) => this.sandbox.admin.listDocuments(`sokoban/${l.id}/scores/`));
    const objects: unknown[] = [];
    const walk = async (path: string) => {
      const listing = await listAll(ref(this.admin, path));
      for (const item of listing.items) {
        const meta = await getMetadata(item);
        const bytes = new TextDecoder().decode(await getBytes(item));
        objects.push([item.fullPath, meta.contentType, meta.size, meta.customMetadata, meta.updated, bytes]);
      }
      for (const prefix of listing.prefixes) await walk(prefix.fullPath);
    };
    await walk('sokoban');
    return JSON.stringify({ docs, objects });
  }

  score(level: string, uid: string): ScoreFields | undefined {
    return this.sandbox.admin.getDocument(scorePath(level, uid)) as ScoreFields | undefined;
  }

  async writeScore(uid: string | null, path: string, data: Data): Promise<void> {
    await this.db(uid).doc(path).set({ ...data, createdAt: FieldValue.serverTimestamp() });
  }

  async upload(uid: string | null, u: Upload): Promise<void> {
    await uploadString(ref(this.storage(uid), u.path), u.text, 'raw', { contentType: u.contentType, customMetadata: u.customMetadata });
  }

  /** The client's solve: the score, then the object. */
  async solve(uid: string, w: SolveWrites): Promise<void> {
    await this.writeScore(uid, w.score.path, w.score.data as unknown as Data);
    await this.upload(uid, w.upload);
  }

  async allowed(label: string, run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (e) {
      this.failures.push(`denied: ${label} (${(e as Error).message})`);
      return false;
    }
  }

  async denied(label: string, run: () => Promise<unknown>): Promise<void> {
    const before = await this.snapshot();
    try {
      await run();
      this.failures.push(`allowed: ${label}`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!['permission-denied', 'storage/unauthorized', 'storage/unauthenticated'].includes(code ?? '')) {
        this.failures.push(`${label}: failed with ${code} ${(e as Error).message}`);
      }
    }
    if ((await this.snapshot()) !== before) this.failures.push(`changed state: ${label}`);
  }

  /** Download an entry's object as `reader` and check it by replay. */
  async verify(reader: string, level: string, uid: string): Promise<ReturnType<typeof verifyEntry>> {
    const entry = this.score(level, uid);
    if (!entry) return { ok: false, reason: 'no score' };
    const object = ref(this.storage(reader), entry.object);
    let text: string | null = null;
    let meta: Record<string, string> | undefined;
    try {
      text = new TextDecoder().decode(await getBytes(object));
      meta = (await getMetadata(object)).customMetadata as Record<string, string> | undefined;
    } catch {
      text = null;
    }
    return verifyEntry(entry, text, meta);
  }
}

/** The score write of `w` with `patch` merged into its data. */
const scoreWith = (w: SolveWrites, patch: Data): Data => ({ ...w.score.data, ...patch });

describe('Sokoban Firestore and Storage rules', () => {
  test('every real solve is allowed, replays, and each player improves their best', async () => {
    const world = new World();
    for (const spec of LEVELS) {
      const level = spec.id;
      // Alice solves the long way, then improves; Bob solves once. Carol reads both.
      const slow = solveWrites('alice-uid', level, solveId(), detour(level));
      await world.allowed(`alice solves ${level} with a detour`, () => world.solve('alice-uid', slow));
      const fast = solveWrites('alice-uid', level, solveId(), SOLUTIONS.get(level)!);
      await world.allowed(`alice improves ${level}`, () => world.solve('alice-uid', fast));
      const bob = solveWrites('bob-uid', level, solveId(), SOLUTIONS.get(level)!);
      await world.allowed(`bob solves ${level}`, () => world.solve('bob-uid', bob));
      for (const uid of ['alice-uid', 'bob-uid']) {
        const verdict = await world.verify('carol-uid', level, uid);
        if (!verdict.ok) world.failures.push(`replay rejects ${uid} on ${level}: ${verdict.reason}`);
      }
      // The replaced solve's object stays readable.
      await world.allowed(`carol reads alice's first solve on ${level}`, () => getBytes(ref(world.storage('carol-uid'), slow.upload.path)));
    }
    expect(world.score('1', 'alice-uid')?.moves).toBe(33);
    // Pushes break a tie in moves: a score with as many moves and fewer pushes improves.
    const tied = solveWrites('dave-uid', '1', solveId(), SOLUTIONS.get('1')!);
    const more = { ...tied.score.data, pushes: 9, object: tied.score.data.object.replace('-33-8', '-33-9') };
    await world.allowed('dave claims 33 moves and 9 pushes', () => world.writeScore('dave-uid', tied.score.path, more));
    await world.allowed('dave improves to 33 moves and 8 pushes', () => world.solve('dave-uid', tied));
    expect(world.failures).toEqual([]);
  }, 120_000);

  test('Firestore cheats are denied and change nothing', async () => {
    const world = new World();
    const moves = SOLUTIONS.get('1')!;
    const real = solveWrites('alice-uid', '1', solveId(), moves);
    const put = (uid: string | null, data: Data, path = real.score.path) => () => world.writeScore(uid, path, data);

    await world.denied('a score written by another user', put('bob-uid', real.score.data as unknown as Data));
    await world.denied('a score written without signing in', put(null, real.score.data as unknown as Data));
    await world.denied('a score for a level the arcade does not have', () => {
      const w = solveWrites('alice-uid', '6', solveId(), moves);
      return world.writeScore('alice-uid', w.score.path, w.score.data as unknown as Data);
    });
    await world.denied('a score for level 99 at its own path', () => {
      const w = solveWrites('alice-uid', '99', solveId(), moves);
      return world.writeScore('alice-uid', w.score.path, w.score.data as unknown as Data);
    });
    const counts = (m: unknown, p: unknown) => {
      const solve = real.score.data.solve;
      return scoreWith(real, { moves: m, pushes: p, object: `sokoban/alice-uid/1/${solve}-${m}-${p}.txt` });
    };
    await world.denied('a negative move count', put('alice-uid', counts(-33, 8)));
    await world.denied('a negative push count', put('alice-uid', counts(33, -8)));
    await world.denied('a non-integer move count', put('alice-uid', counts(33.5, 8)));
    await world.denied('a non-integer push count', put('alice-uid', counts(33, 8.5)));
    await world.denied('a move count as a string', put('alice-uid', counts('33', 8)));
    await world.denied('a push count as a string', put('alice-uid', counts(33, '8')));
    await world.denied('fewer moves than the level allows', put('alice-uid', counts(32, 8)));
    await world.denied('fewer pushes than the level allows', put('alice-uid', counts(40, 7)));
    await world.denied('more pushes than moves', put('alice-uid', counts(2000, 2001)));
    await world.denied('more than 2,000 moves', put('alice-uid', counts(2001, 8)));
    await world.denied("a score naming someone else's object", put('alice-uid', scoreWith(real, { object: real.score.data.object.replace('alice-uid', 'bob-uid') })));
    await world.denied('a score naming an object on another level', put('alice-uid', scoreWith(real, { object: real.score.data.object.replace('/1/', '/2/') })));
    await world.denied('a score naming an object with other counts', put('alice-uid', scoreWith(real, { object: real.score.data.object.replace('-33-8', '-40-8') })));
    await world.denied('a score naming an object outside sokoban', put('alice-uid', scoreWith(real, { object: `x/${real.score.data.object}` })));
    await world.denied('a score naming another solve id', put('alice-uid', scoreWith(real, { object: real.score.data.object.replace('Solve', 'Other') })));
    await world.denied('a solve id that is too short', put('alice-uid', scoreWith(real, { solve: 'abc', object: 'sokoban/alice-uid/1/abc-33-8.txt' })));
    await world.denied('a solve id with a slash', put('alice-uid', scoreWith(real, { solve: 'aaaaaaaaa/aaaaaaaaaa', object: 'sokoban/alice-uid/1/aaaaaaaaa/aaaaaaaaaa-33-8.txt' })));
    await world.denied('a solve id that is not a string', put('alice-uid', scoreWith(real, { solve: 12345678901234567890 })));
    await world.denied('a score for another uid in its fields', put('alice-uid', scoreWith(real, { uid: 'bob-uid' })));
    await world.denied('a score for another level in its fields', put('alice-uid', scoreWith(real, { level: '2' })));
    await world.denied('a score with an extra field', put('alice-uid', scoreWith(real, { verified: true })));
    await world.denied('a score with a client clock', () => world.db('alice-uid').doc(real.score.path).set({ ...real.score.data, createdAt: new Date(0) }));
    await world.denied('a score without createdAt', () => world.db('alice-uid').doc(real.score.path).set({ ...real.score.data }));
    await world.denied('a score at a path outside the leaderboard', put('alice-uid', real.score.data as unknown as Data, 'sokoban/1'));

    // The real score, then updates that don't improve it.
    await world.allowed('the real score', put('alice-uid', real.score.data as unknown as Data));
    const again = solveWrites('alice-uid', '1', solveId(), moves);
    await world.denied('a score with the same counts', put('alice-uid', again.score.data as unknown as Data));
    const longer = solveWrites('alice-uid', '1', solveId(), detour('1'));
    await world.denied('a score with more moves', put('alice-uid', longer.score.data as unknown as Data));
    await world.denied('a score with as many moves and more pushes', put('alice-uid', scoreWith(again, { pushes: 9, object: again.score.data.object.replace('-33-8', '-33-9') })));
    // Fewer pushes improve only on as many moves: 20/5 on level 2, then 30/4.
    const bobLevel2 = (m: number, p: number) => ({ uid: 'bob-uid', level: '2', moves: m, pushes: p, solve: real.score.data.solve, object: `sokoban/bob-uid/2/${real.score.data.solve}-${m}-${p}.txt` });
    await world.allowed('bob claims 20 moves and 5 pushes on level 2', put('bob-uid', bobLevel2(20, 5), scorePath('2', 'bob-uid')));
    await world.denied('a score with more moves and fewer pushes', put('bob-uid', bobLevel2(30, 4), scorePath('2', 'bob-uid')));
    await world.denied("another user replaces alice's score", put('bob-uid', { ...again.score.data, moves: 34, object: again.score.data.object.replace('-33-8', '-34-8') }));
    await world.denied('an improvement with a client clock', () => world.db('alice-uid').doc(real.score.path).set({ ...real.score.data, moves: 20, createdAt: new Date() }));
    await world.denied('alice deletes her score', () => world.db('alice-uid').doc(real.score.path).delete());
    await world.denied('bob deletes her score', () => world.db('bob-uid').doc(real.score.path).delete());
    await world.allowed('anyone signed in reads the leaderboard', () => world.db('carol-uid').collection('sokoban/1/scores').get());
    await world.denied('the leaderboard is not public', async () => {
      await world.db(null).collection('sokoban/1/scores').get();
    });
    expect(world.failures).toEqual([]);
  }, 120_000);

  test('Storage cheats are denied and change nothing, including the cross-service check', async () => {
    const world = new World();
    const moves = SOLUTIONS.get('2')!;
    const real = solveWrites('alice-uid', '2', solveId(), moves);
    const up = (uid: string | null, u: Upload) => () => world.upload(uid, u);
    const withMeta = (patch: Record<string, string | undefined>): Upload => ({
      ...real.upload,
      customMetadata: Object.fromEntries(Object.entries({ ...real.upload.customMetadata, ...patch }).filter(([, v]) => v !== undefined)) as Upload['customMetadata'],
    });

    // Cross-service: no score yet.
    await world.denied('an upload with no matching score', up('alice-uid', real.upload));
    await world.allowed("alice's score", () => world.writeScore('alice-uid', real.score.path, real.score.data as unknown as Data));
    // Cross-service: a score that names another object.
    const other = solveWrites('alice-uid', '2', solveId(), moves);
    await world.denied('an upload the score does not name', up('alice-uid', other.upload));
    await world.denied("bob uploads under alice's uid", up('bob-uid', real.upload));
    await world.denied('an upload without signing in', up(null, real.upload));
    await world.denied('a wrong contentType', up('alice-uid', { ...real.upload, contentType: 'application/octet-stream' }));
    await world.denied('an HTML move list', up('alice-uid', { ...real.upload, contentType: 'text/html' }));
    await world.denied('an oversize file', up('alice-uid', { ...real.upload, text: 'l'.repeat(2001) }));
    await world.denied('a file shorter than the move count', up('alice-uid', { ...real.upload, text: moves.slice(1) }));
    await world.denied('a file longer than the move count', up('alice-uid', { ...real.upload, text: `${moves}l` }));
    await world.denied('metadata for another level', up('alice-uid', withMeta({ level: '1' })));
    await world.denied('metadata with other moves', up('alice-uid', withMeta({ moves: '17' })));
    await world.denied('metadata with other pushes', up('alice-uid', withMeta({ pushes: '4' })));
    await world.denied('metadata without the level', up('alice-uid', withMeta({ level: undefined })));
    await world.denied('metadata without the moves', up('alice-uid', withMeta({ moves: undefined })));
    await world.denied('metadata with an extra key', up('alice-uid', withMeta({ verified: 'yes' })));
    await world.denied('no metadata', up('alice-uid', { ...real.upload, customMetadata: undefined as never }));
    await world.denied('an upload at a sibling path', up('alice-uid', { ...real.upload, path: real.upload.path.replace('.txt', '.bin') }));
    await world.denied('an upload under the level of another score', up('alice-uid', { ...real.upload, path: real.upload.path.replace('/2/', '/1/') }));

    await world.allowed('the real upload', up('alice-uid', real.upload));
    // An upload over an existing object is a create in production, so the owner can upload it again.
    await world.allowed('alice uploads her solve again', up('alice-uid', real.upload));
    await world.denied("bob overwrites alice's solve", up('bob-uid', real.upload));
    // A move list of the same length that solves nothing passes the rules and is flagged by the replay.
    await world.allowed('alice overwrites her solve with moves that solve nothing', up('alice-uid', { ...real.upload, text: 'l'.repeat(moves.length) }));
    if ((await world.verify('carol-uid', '2', 'alice-uid')).ok) world.failures.push('the replay missed an overwritten move list');
    await world.allowed('alice restores her solve', up('alice-uid', real.upload));
    await world.denied('alice changes her solve\'s metadata', () =>
      updateMetadata(ref(world.storage('alice-uid'), real.upload.path), { customMetadata: real.upload.customMetadata }));
    await world.denied('alice deletes her solve', () => deleteObject(ref(world.storage('alice-uid'), real.upload.path)));
    await world.denied("bob deletes alice's solve", () => deleteObject(ref(world.storage('bob-uid'), real.upload.path)));
    await world.allowed("bob reads alice's solve", () => getBytes(ref(world.storage('bob-uid'), real.upload.path)));
    await world.denied('reading a solve without signing in', () => getBytes(ref(world.storage(null), real.upload.path)));

    // Bob's score names alice's object: Firestore denies it, and his upload there is denied too.
    await world.denied("bob's score naming alice's object", () =>
      world.writeScore('bob-uid', scorePath('2', 'bob-uid'), { ...real.score.data, uid: 'bob-uid' }));
    const bobs = solveWrites('bob-uid', '2', solveId(), moves);
    await world.denied("bob's upload with alice's score", up('bob-uid', { ...bobs.upload, path: objectPath('bob-uid', '2', real.score.data.solve, 16, 3) }));
    await world.allowed("bob's own solve", () => world.solve('bob-uid', bobs));
    expect(world.failures).toEqual([]);
  }, 120_000);

  test('a forged solve the rules allow is flagged by the replay', async () => {
    const world = new World();
    // Counts at the level's minimum, a move list of the right length and push count that solves nothing.
    const spec = LEVELS[0];
    const text = 'L'.repeat(spec.minPushes) + 'l'.repeat(spec.minMoves - spec.minPushes);
    const forged = solveWrites('mallory-uid', spec.id, solveId(), text);
    expect(forged.score.data.moves).toBe(spec.minMoves);
    expect(forged.score.data.pushes).toBe(spec.minPushes);
    await world.allowed('a forged solve (rules cannot replay)', () => world.solve('mallory-uid', forged));
    const verdict = await world.verify('alice-uid', spec.id, 'mallory-uid');
    if (verdict.ok) world.failures.push('the replay missed a forged solve');

    // A score whose upload never happened.
    const missing = solveWrites('trent-uid', spec.id, solveId(), SOLUTIONS.get(spec.id)!);
    await world.allowed('a score without its upload', () => world.writeScore('trent-uid', missing.score.path, missing.score.data as unknown as Data));
    const none = await world.verify('alice-uid', spec.id, 'trent-uid');
    if (none.ok || none.reason !== 'no move list') world.failures.push(`a missing move list gave ${JSON.stringify(none)}`);
    expect(world.failures).toEqual([]);
  }, 60_000);
});
