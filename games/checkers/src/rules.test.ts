/**
 * Checkers Security Rules against Pyric's sandbox. Seeded games play random
 * legal moves through the same update the browser writes; every real move must
 * be allowed, and before each one a set of cheats derived from it must be
 * denied and leave the match unchanged.
 *
 * The rules can't check jump geometry or a win claim: a consistent but
 * illegal move is allowed, and the replay check (`verifyMove`) must catch it.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { mulberry32 } from '@games/harness';
import { createdMatch, joinedMatch } from '@games/turn-net/transitions';
import { isPlayable, legalMoves, squareName, squareOf, type Move } from './checkers.ts';
import { COLLECTION, checkers, moveUpdate, positionOf, sideOfSeat, verifyMove, type CheckersDoc } from './logic.ts';

const rules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();

type Db = ReturnType<typeof getFirestore>;
type Data = Record<string, unknown>;

function setup(seed: number) {
  const sandbox = initializeSandbox();
  getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(rules);
  const dbFor = {
    host: getFirestore(sandbox.withAuth({ uid: 'host-uid' })),
    guest: getFirestore(sandbox.withAuth({ uid: 'guest-uid' })),
  };
  const stranger = getFirestore(sandbox.withAuth({ uid: 'stranger-uid' }));
  const path = `${COLLECTION}/m${seed}`;
  const failures: string[] = [];
  const stored = () => sandbox.admin.getDocument(path) as CheckersDoc;
  const denied = async (write: () => Promise<unknown>) => {
    try {
      await write();
      return false;
    } catch (e) {
      return (e as { code?: string }).code === 'permission-denied';
    }
  };
  const expectDenied = async (label: string, db: Db, data: Data) => {
    const before = JSON.stringify(stored());
    if (!(await denied(() => db.doc(path).update(data)))) failures.push(`allowed: ${label}`);
    if (JSON.stringify(stored()) !== before) failures.push(`changed state: ${label}`);
  };
  const expectAllowed = async (label: string, db: Db, data: Data) => {
    try {
      await db.doc(path).update(data);
      return true;
    } catch (e) {
      failures.push(`denied: ${label} (${(e as Error).message})`);
      return false;
    }
  };
  return { sandbox, dbFor, stranger, path, failures, stored, denied, expectDenied, expectAllowed };
}

type Env = ReturnType<typeof setup>;

async function createAndJoin(env: Env): Promise<void> {
  const fresh = { ...createdMatch(checkers, 'host-uid'), createdAt: FieldValue.serverTimestamp() } as Data;
  const board = fresh.board as Record<string, string>;
  const create = (data: Data) => env.dbFor.host.doc(env.path).set(data);
  const createDenied = async (label: string, data: Data) => {
    if (!(await env.denied(() => create(data)))) env.failures.push(`allowed: ${label}`);
  };
  await createDenied('create with a king already crowned', { ...fresh, board: { ...board, a1: 'D' }, prevBoard: { ...board, a1: 'D' } });
  await createDenied('create with a piece missing from the other side', { ...fresh, board: { ...board, b8: '' } });
  await createDenied('create with light to move', { ...fresh, currentTurn: 'guest' });
  await createDenied('create with a last move', { ...fresh, lastMove: { path: ['c3', 'd4'], captures: [] } });
  await createDenied('create with a move already made', { ...fresh, moveCount: 1 });
  await createDenied('create with an extra field', { ...fresh, timer: 60 });
  await createDenied('create with a client clock', { ...fresh, createdAt: new Date(0) });
  await createDenied('create with a winner', { ...fresh, winner: 'host' });
  await createDenied('create with a previous position', { ...fresh, prevBoard: { ...board, c3: '', d4: 'd' } });
  try {
    await create(fresh);
  } catch (e) {
    env.failures.push(`denied: create (${(e as Error).message})`);
    return;
  }
  const joined = joinedMatch(env.stored(), 'guest-uid');
  await env.expectDenied('dark joins their own match', env.dbFor.host, { guest: 'host-uid', status: 'playing' });
  await env.expectDenied('join and take the first move', env.dbFor.guest, { guest: joined.guest, status: joined.status, currentTurn: 'guest' });
  await env.expectAllowed('join', env.dbFor.guest, { guest: joined.guest, status: joined.status });
  await env.expectDenied('join a full match', env.stranger, { guest: 'stranger-uid' });
}

async function moveCheats(env: Env, doc: CheckersDoc, real: ReturnType<typeof moveUpdate>, move: Move): Promise<void> {
  const seat = doc.currentTurn;
  const other: 'host' | 'guest' = seat === 'host' ? 'guest' : 'host';
  const me = env.dbFor[seat];
  const mine = sideOfSeat(seat);
  const from = squareName(move.path[0]);
  const to = squareName(move.path[move.path.length - 1]);
  const board = real.board;
  const edit = (change: Data) => ({ ...real, ...change }) as Data;
  const squares = Object.keys(doc.board);

  await env.expectDenied('move out of turn', env.dbFor[other], real as unknown as Data);
  await env.expectDenied('a stranger moves', env.stranger, real as unknown as Data);
  await env.expectDenied('leave the piece on its square too', me, edit({ board: { ...board, [from]: doc.board[from] } }));
  if (board[to] === doc.board[from]) {
    const crowned = mine === 'd' ? 'D' : 'L';
    if (doc.board[from] === mine) await env.expectDenied('crown a man short of the far row', me, edit({ board: { ...board, [to]: crowned } }));
    await env.expectDenied('turn the piece into the other side\'s', me, edit({ board: { ...board, [to]: mine === 'd' ? 'l' : 'd' } }));
  }
  const bystander = squares.find((sq) => doc.board[sq] !== '' && doc.board[sq].toLowerCase() !== mine && !real.lastMove.captures.includes(sq));
  if (bystander) {
    await env.expectDenied('remove a piece without capturing it', me, edit({ board: { ...board, [bystander]: '' } }));
    if (move.captures.length === 1) {
      await env.expectDenied('jump once and capture a second piece', me, edit({ board: { ...board, [bystander]: '' }, lastMove: { ...real.lastMove, captures: [...real.lastMove.captures, bystander] } }));
    }
    if (move.captures.length === 0) {
      await env.expectDenied('list a capture on a step', me, edit({ board: { ...board, [bystander]: '' }, lastMove: { ...real.lastMove, captures: [bystander] } }));
    }
  }
  const theirs = squares.find((sq) => doc.board[sq] !== '' && doc.board[sq].toLowerCase() !== mine);
  const empty = squares.find((sq) => doc.board[sq] === '');
  if (theirs && empty) {
    await env.expectDenied("move the opponent's piece", me, edit({
      board: { ...doc.board, [theirs]: '', [empty]: doc.board[theirs] },
      lastMove: { path: [theirs, empty], captures: [] },
    }));
  }
  const occupied = squares.find((sq) => doc.board[sq] !== '' && sq !== from);
  if (occupied) {
    await env.expectDenied('land on an occupied square', me, edit({
      board: { ...doc.board, [from]: '', [occupied]: doc.board[from] },
      lastMove: { path: [from, occupied], captures: [] },
    }));
  }
  const far = squares.find((sq) => doc.board[sq] === '' && Math.abs(squareOf(sq) % 8 - move.path[0] % 8) > 1);
  if (far) {
    await env.expectDenied('slide a piece to a far square', me, edit({
      board: { ...doc.board, [from]: '', [far]: doc.board[from] },
      lastMove: { path: [from, far], captures: [] },
    }));
  }
  const tall = squares.find((sq) => doc.board[sq] === '' && Math.abs(squareOf(sq) % 8 - move.path[0] % 8) === 1
    && Math.abs(Math.floor(squareOf(sq) / 8) - Math.floor(move.path[0] / 8)) > 1);
  if (tall) {
    await env.expectDenied('step one file over but ranks away', me, edit({
      board: { ...doc.board, [from]: '', [tall]: doc.board[from] },
      lastMove: { path: [from, tall], captures: [] },
    }));
  }
  const neighbor = squares.find((sq) => doc.board[sq] !== '' && sq !== from
    && Math.abs(squareOf(sq) % 8 - move.path[0] % 8) === 1 && Math.abs(Math.floor(squareOf(sq) / 8) - Math.floor(move.path[0] / 8)) === 1);
  if (neighbor) {
    await env.expectDenied('step onto a neighboring piece', me, edit({
      board: { ...doc.board, [from]: '', [neighbor]: doc.board[from] },
      lastMove: { path: [from, neighbor], captures: [] },
    }));
  }
  await env.expectDenied('a move with no destination', me, edit({ lastMove: { path: [from], captures: [] } }));
  await env.expectDenied('rewrite the board before the move', me, edit({ prevBoard: board }));
  await env.expectDenied('keep the turn', me, edit({ currentTurn: seat }));
  await env.expectDenied('skip a move number', me, edit({ moveCount: doc.moveCount + 2 }));
  await env.expectDenied('name the opponent the winner', me, edit({ status: 'won', winner: other }));
  if (real.status === 'playing') await env.expectDenied('name a winner while play goes on', me, edit({ winner: seat }));
  await env.expectDenied('add a square to the board', me, edit({ board: { ...board, a2: 'd' } }));
  await env.expectDenied('add a field to the move', me, edit({ lastMove: { ...real.lastMove, note: 'x' } }));
  await env.expectDenied('add a field', me, edit({ extra: true }));
  await env.expectDenied('replace the opponent', me, edit({ [other]: 'stranger-uid' }));
}

async function playGame(seed: number, maxPlies: number) {
  const env = setup(seed);
  const random = mulberry32(seed);
  await createAndJoin(env);
  let illegalCaught = false;
  let plies = 0;
  for (; plies < maxPlies && env.stored().status === 'playing'; plies++) {
    const doc = env.stored();
    const moves = legalMoves(positionOf(doc.board, doc.currentTurn));
    const move = moves[Math.floor(random() * moves.length)];
    const real = moveUpdate(doc, move);
    await moveCheats(env, doc, real, move);

    if (plies === 3 && !illegalCaught && move.captures.length === 0) {
      // A step dressed as a double jump that removes two enemy pieces far away: the rules check
      // single hops only, so this is consistent with them but not legal checkers.
      const victims = Object.keys(doc.board).filter((sq) => doc.board[sq] !== '' && doc.board[sq].toLowerCase() !== sideOfSeat(doc.currentTurn)).slice(0, 2);
      if (victims.length === 2) {
        const [from, to] = real.lastMove.path;
        const forged = {
          ...real,
          board: { ...real.board, [victims[0]]: '', [victims[1]]: '' },
          lastMove: { path: [from, victims[0], to], captures: victims },
        };
        if (!(await env.expectAllowed('a double jump from across the board (rules cannot see multi-jump geometry)', env.dbFor[doc.currentTurn], forged))) break;
        if (verifyMove(env.stored())) env.failures.push('replay missed an illegal capture');
        else illegalCaught = true;
        continue;
      }
    }
    if (!(await env.expectAllowed(`ply ${plies + 1} ${real.lastMove.path.join('-')}`, env.dbFor[doc.currentTurn], real))) break;
    if (!verifyMove(env.stored())) env.failures.push(`ply ${plies + 1}: replay disagrees with a real move`);
  }
  return { plies, illegalCaught, failures: env.failures };
}

/** A seeded ending: dark jumps light's last piece and wins; then a false win claim and a resignation. */
async function endings(): Promise<string[]> {
  const env = setup(99);
  await createAndJoin(env);
  const empty = Object.fromEntries(Object.keys(env.stored().board).map((sq) => [sq, '']));
  const board = { ...empty, c3: 'd', d4: 'l', a1: 'd' };
  const seeded = { ...env.stored(), board, prevBoard: board, moveCount: 30 } as CheckersDoc;
  env.sandbox.admin.setDocument(env.path, seeded as unknown as Data);
  const moves = legalMoves(positionOf(board, 'host'));
  const jump = moves.find((m) => m.captures.length === 1)!;
  const win = moveUpdate(seeded, jump);
  if (win.status !== 'won') env.failures.push('the seeded ending did not end the game');
  await env.expectDenied('jump once and capture a second piece', env.dbFor.host, {
    ...win, board: { ...win.board, a1: '' }, lastMove: { ...win.lastMove, captures: [...win.lastMove.captures, 'a1'] },
  });
  await env.expectAllowed('dark captures the last light piece and wins', env.dbFor.host, win);
  if (!verifyMove(env.stored())) env.failures.push('replay rejected a real win');

  {
    // A jump c3 over d4 to e5 that removes the wrong piece: one on d4's rank, one on its file.
    const wrong = setup(96);
    await createAndJoin(wrong);
    const empty2 = Object.fromEntries(Object.keys(wrong.stored().board).map((sq) => [sq, '']));
    const b = { ...empty2, c3: 'd', d4: 'l', f4: 'l', d2: 'l' };
    wrong.sandbox.admin.setDocument(wrong.path, { ...wrong.stored(), board: b, prevBoard: b, moveCount: 30 } as unknown as Data);
    const doc = wrong.stored();
    const jumpOver = legalMoves(positionOf(b, 'host')).find((m) => m.captures.length === 1 && squareName(m.captures[0]) === 'd4')!;
    const real = moveUpdate(doc, jumpOver);
    for (const victim of ['f4', 'd2']) {
      await wrong.expectDenied(`jump over d4 but capture ${victim}`, wrong.dbFor.host, {
        ...real, board: { ...real.board, d4: 'l', [victim]: '' }, lastMove: { ...real.lastMove, captures: [victim] },
      });
    }
    await wrong.expectAllowed('jump over d4', wrong.dbFor.host, real);
    env.failures.push(...wrong.failures);
  }
  {
    // A dark man reaching the far row is crowned: a7 to b8.
    const crown = setup(95);
    await createAndJoin(crown);
    const blank = Object.fromEntries(Object.keys(crown.stored().board).map((sq) => [sq, '']));
    const b = { ...blank, a7: 'd', h2: 'l' };
    crown.sandbox.admin.setDocument(crown.path, { ...crown.stored(), board: b, prevBoard: b, moveCount: 40 } as unknown as Data);
    const up = moveUpdate(crown.stored(), { path: [squareOf('a7'), squareOf('b8')], captures: [] });
    if (up.board.b8 !== 'D') crown.failures.push('the man was not crowned');
    await crown.expectAllowed('a man reaches the far row and is crowned', crown.dbFor.host, up);
    if (!verifyMove(crown.stored())) crown.failures.push('replay rejected a crowning');
    env.failures.push(...crown.failures);
  }
  const other = setup(98);
  await createAndJoin(other);
  const doc = other.stored();
  const step = legalMoves(positionOf(doc.board, 'host'))[0];
  const claim = { ...moveUpdate(doc, step), status: 'won', winner: 'host' };
  await other.expectAllowed('a false win claim (rules cannot see the position)', other.dbFor.host, claim);
  if (verifyMove(other.stored())) other.failures.push('replay missed a false win claim');

  const third = setup(97);
  await createAndJoin(third);
  await third.expectDenied('a stranger resigns the match', third.stranger, { status: 'resigned', winner: 'host' });
  await third.expectDenied('light resigns for dark', third.dbFor.guest, { status: 'resigned', winner: 'guest' });
  await third.expectAllowed('light resigns', third.dbFor.guest, { status: 'resigned', winner: 'host' });
  return [...env.failures, ...other.failures, ...third.failures];
}

describe('Checkers Security Rules', () => {
  test('real moves allowed, cheats denied, illegal moves caught by replay', async () => {
    const results = [];
    for (const seed of [1, 2, 3]) results.push(await playGame(seed, 40));
    const failures = results.flatMap((r, i) => r.failures.map((f) => `game ${i + 1}: ${f}`));
    expect(failures.slice(0, 20)).toEqual([]);
    expect(results.some((r) => r.illegalCaught)).toBe(true);
  }, 60_000);

  test('a win, a false win claim, and resignation', async () => {
    expect(await endings()).toEqual([]);
  }, 60_000);
});

test('the board has 32 playable squares', () => {
  expect(Array.from({ length: 64 }, (_, sq) => sq).filter(isPlayable).length).toBe(32);
  expect(squareOf('c3')).toBe(42);
});
