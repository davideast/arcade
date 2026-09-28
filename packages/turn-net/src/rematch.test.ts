/**
 * Rematch Security Rules against Pyric's sandbox. A player of a finished match
 * proposes the rematch in the batch that creates the new match; every real
 * proposal must be allowed, and every cheat denied without changing anything.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { createdMatch, joinedMatch } from './transitions.ts';
import { ticTacToe } from '../../../games/tictactoe/src/logic.ts';
import { createdMatch as unoTable } from '../../../games/uno/src/logic.ts';
import { createdMatch as battleshipMatch } from '../../../games/battleship/src/logic.ts';
import { reversi } from '../../../games/reversi/src/logic.ts';

const rules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();

type Data = Record<string, unknown>;

/** The new match each game's client writes; two-seat games name the finished match in `rematchOf`. */
const FRESH: Record<string, (uid: string, finished: string) => Data> = {
  tictactoe: (uid, finished) => ({ ...createdMatch(ticTacToe, uid), rematchOf: finished }),
  uno: (uid) => ({ ...unoTable(uid) }),
  battleship: (uid, finished) => ({ ...battleshipMatch(uid), rematchOf: finished }),
  reversi: (uid, finished) => ({ ...createdMatch(reversi, uid), rematchOf: finished }),
};

function setup() {
  const sandbox = initializeSandbox();
  getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(rules);
  const as = (uid: string) => getFirestore(sandbox.withAuth({ uid }));
  const failures: string[] = [];
  let next = 0;

  const ticTacToeDone = { ...createdMatch(ticTacToe, 'host-uid'), guest: 'guest-uid', status: 'resigned', winner: 'guest', createdAt: new Date(0) };
  const seed: Record<string, Data> = {
    'tictactoe/resigned': ticTacToeDone,
    'tictactoe/drawn': { ...ticTacToeDone, status: 'draw', winner: '' },
    'tictactoe/won': { ...ticTacToeDone, status: 'won', winner: 'host' },
    'tictactoe/playing': { ...ticTacToeDone, status: 'playing', winner: '' },
    'tictactoe/waiting': { ...ticTacToeDone, guest: '', status: 'waiting', winner: '' },
    'uno/won': { ...unoTable('host-uid'), players: ['host-uid', 'guest-uid', 'third-uid'], status: 'won', winner: 'third-uid', createdAt: new Date(0) },
    'uno/playing': { ...unoTable('host-uid'), players: ['host-uid', 'guest-uid'], status: 'playing', createdAt: new Date(0) },
    'battleship/won': { ...battleshipMatch('host-uid'), guest: 'guest-uid', status: 'won', winner: 'host', createdAt: new Date(0) },
    'reversi/drawn': { ...createdMatch(reversi, 'host-uid'), guest: 'guest-uid', status: 'draw', winner: '', createdAt: new Date(0) },
    'scores/resigned': ticTacToeDone,
  };
  for (const [path, data] of Object.entries(seed)) sandbox.admin.setDocument(path, data);

  const snapshot = () => JSON.stringify(['rematches/tictactoe/matches/', 'rematches/uno/matches/', 'rematches/battleship/matches/', 'rematches/scores/matches/', 'scores/', 'tictactoe/', 'uno/', 'battleship/', 'chess/'].map((c) => sandbox.admin.listDocuments(c)));

  /**
   * The batch the client writes: the new match hosted by `uid` and the
   * rematch naming it. `change` edits the rematch document; `create: false`
   * leaves the new match out.
   */
  const propose = (uid: string, game: string, finished: string, options: { change?: (d: Data) => Data; match?: string; create?: boolean } = {}) => {
    const id = options.match ?? `next${next++}`;
    const db = as(uid);
    const batch = db.batch();
    if (options.create !== false) batch.set(db.doc(`${game}/${id}`), { ...FRESH[game](uid, finished), createdAt: FieldValue.serverTimestamp() });
    const rematch = { game, match: id, by: uid };
    batch.set(db.doc(`rematches/${game}/matches/${finished}`), options.change ? options.change(rematch) : rematch);
    return { id, commit: () => batch.commit() };
  };

  const allowed = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e) {
      failures.push(`denied: ${label} (${(e as Error).message})`);
    }
  };
  const denied = async (label: string, run: () => Promise<unknown>) => {
    const before = snapshot();
    try {
      await run();
      failures.push(`allowed: ${label}`);
    } catch (e) {
      if ((e as { code?: string }).code !== 'permission-denied') failures.push(`failed: ${label} (${(e as Error).message})`);
    }
    if (snapshot() !== before) failures.push(`changed state: ${label}`);
  };
  return { sandbox, as, failures, propose, allowed, denied };
}

describe('rematch Security Rules', () => {
  test('allow every real rematch and deny every cheat', async () => {
    const env = setup();
    const { propose, allowed, denied, as } = env;

    // Cheats first, while no rematch exists.
    await denied('a stranger proposes', () => propose('stranger-uid', 'tictactoe', 'resigned').commit());
    await denied('a stranger proposes at an Uno table', () => propose('stranger-uid', 'uno', 'won').commit());
    await denied('propose on a match in play', () => propose('host-uid', 'tictactoe', 'playing').commit());
    await denied('propose on a waiting match', () => propose('host-uid', 'tictactoe', 'waiting').commit());
    await denied('propose on an Uno table in play', () => propose('guest-uid', 'uno', 'playing').commit());
    await denied('propose with an extra field', () => propose('guest-uid', 'tictactoe', 'resigned', { change: (d) => ({ ...d, note: 'gg' }) }).commit());
    await denied('propose for another player', () => propose('guest-uid', 'tictactoe', 'resigned', { change: (d) => ({ ...d, by: 'host-uid' }) }).commit());
    await denied('name the wrong game', () => propose('guest-uid', 'tictactoe', 'resigned', { change: (d) => ({ ...d, game: 'chess' }) }).commit());
    await denied('propose in a collection outside the arcade', async () => {
      const db = as('guest-uid');
      const batch = db.batch();
      batch.set(db.doc('scores/next'), { ...FRESH.tictactoe('guest-uid', 'resigned'), createdAt: FieldValue.serverTimestamp() });
      batch.set(db.doc('rematches/scores/matches/resigned'), { game: 'scores', match: 'next', by: 'guest-uid' });
      await batch.commit();
    });
    await denied('name a match that is never created', () => propose('guest-uid', 'tictactoe', 'resigned', { create: false }).commit());
    await denied("name someone else's waiting match", () => propose('guest-uid', 'tictactoe', 'resigned', { match: 'waiting', create: false }).commit());
    await denied('propose without signing in', async () => {
      const db = getFirestore(env.sandbox.withAuth(null as never));
      await db.doc('rematches/tictactoe/matches/resigned').set({ game: 'tictactoe', match: 'nobody', by: '' });
    });

    // A new match that names a finished match in `rematchOf`, written without
    // the rematch document: its own create rule checks the finished match.
    const openNaming = (uid: string, id: string, finished: string) => () =>
      as(uid).doc(`tictactoe/${id}`).set({ ...FRESH.tictactoe(uid, finished), createdAt: FieldValue.serverTimestamp() });
    await denied('open a match that names a match in play as its rematchOf', openNaming('host-uid', 'direct1', 'playing'));
    await denied('open a match that names a waiting match as its rematchOf', openNaming('host-uid', 'direct2', 'waiting'));
    await denied('a stranger opens a match that names a finished match', openNaming('stranger-uid', 'direct3', 'resigned'));
    await denied('open a match that names a match that does not exist', openNaming('guest-uid', 'direct4', 'missing'));

    // Real rematches: resigned, drawn, and won matches; two-seat and Uno.
    const first = propose('guest-uid', 'tictactoe', 'resigned');
    await allowed('the guest proposes after a resignation', first.commit);
    await allowed('the host proposes after a draw', propose('host-uid', 'tictactoe', 'drawn').commit);
    await allowed('the loser proposes after a win', propose('guest-uid', 'tictactoe', 'won').commit);
    await allowed('a third Uno player proposes', propose('third-uid', 'uno', 'won').commit);
    await allowed('the Battleship host proposes', propose('host-uid', 'battleship', 'won').commit);
    await allowed('the Reversi guest proposes after a draw', propose('guest-uid', 'reversi', 'drawn').commit);

    // The other player joins through the game's normal join.
    const joined = joinedMatch(env.sandbox.admin.getDocument(`tictactoe/${first.id}`) as never, 'host-uid');
    await allowed('the host joins the rematch', () => as('host-uid').doc(`tictactoe/${first.id}`).update({ guest: joined.guest, status: joined.status }));

    // One rematch per match.
    await denied('a second rematch', () => propose('host-uid', 'tictactoe', 'resigned').commit());
    await denied('rewrite the rematch', () => as('guest-uid').doc('rematches/tictactoe/matches/resigned').update({ match: 'waiting' }));
    await denied('delete the rematch', () => as('guest-uid').doc('rematches/tictactoe/matches/resigned').delete());

    // Anyone signed in reads it.
    await allowed('a stranger reads the rematch', () => as('stranger-uid').doc('rematches/tictactoe/matches/resigned').get());

    expect(env.failures).toEqual([]);
  }, 120_000);
});
