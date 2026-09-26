/**
 * Chess Security Rules against Pyric's sandbox. Seeded games play random legal
 * moves through the same update the browser writes; every real move must be
 * allowed, and before each one a set of cheats derived from it must be denied
 * and leave the match unchanged.
 *
 * The rules can't check piece geometry or a checkmate claim: a consistent but
 * illegal move is allowed, and the replay check (`verifyMove`) must catch it.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { mulberry32 } from '@games/harness';
import { createdMatch, joinedMatch } from '@games/turn-net/transitions';
import { legalMoves, squareName, squareOf, type Move } from './chess.ts';
import { COLLECTION, chess, colorOf, moveUpdate, positionOf, verifyMove, type ChessDoc } from './logic.ts';

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
  const stored = () => sandbox.admin.getDocument(path) as ChessDoc;
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
  const fresh = { ...createdMatch(chess, 'host-uid'), createdAt: FieldValue.serverTimestamp() } as Data;
  const create = (data: Data) => env.dbFor.host.doc(env.path).set(data);
  const board = fresh.board as Record<string, string>;
  const createDenied = async (label: string, data: Data) => {
    if (!(await env.denied(() => create(data)))) env.failures.push(`allowed: ${label}`);
  };
  await createDenied('create with an extra queen', { ...fresh, board: { ...board, d4: 'wq' }, prevBoard: { ...board, d4: 'wq' } });
  await createDenied('create with a piece moved', { ...fresh, board: { ...board, e2: '', e4: 'wp' } });
  await createDenied('create with black to move', { ...fresh, currentTurn: 'guest' });
  await createDenied('create without castling rights for black', { ...fresh, castling: 'KQ', prevCastling: 'KQ' });
  await createDenied('create with an en passant square', { ...fresh, enPassant: 'e3' });
  await createDenied('create with a move already made', { ...fresh, moveCount: 1 });
  await createDenied('create with a last move', { ...fresh, lastMove: { from: 'e2', to: 'e4', promotion: '', extra: [] } });
  await createDenied('create with an extra field', { ...fresh, clock: 300 });
  await createDenied('create with a client clock', { ...fresh, createdAt: new Date(0) });
  await createDenied('create with a winner', { ...fresh, winner: 'host' });
  await createDenied('create with a previous position', { ...fresh, prevBoard: { ...board, e2: '', e4: 'wp' } });
  await createDenied('create with a previous en passant square', { ...fresh, prevEnPassant: 'e3' });
  await createDenied('create with previous castling rights cut', { ...fresh, prevCastling: 'KQ' });
  await createDenied('create with castling rights cut', { ...fresh, castling: 'KQ' });
  try {
    await create(fresh);
  } catch (e) {
    env.failures.push(`denied: create (${(e as Error).message})`);
    return;
  }
  const joined = joinedMatch(env.stored(), 'guest-uid');
  await env.expectDenied('white joins their own match', env.dbFor.host, { guest: 'host-uid', status: 'playing' });
  await env.expectDenied('join and take the first move', env.dbFor.guest, { guest: joined.guest, status: joined.status, currentTurn: 'guest' });
  await env.expectAllowed('join', env.dbFor.guest, { guest: joined.guest, status: joined.status });
  await env.expectDenied('join a full match', env.stranger, { guest: 'stranger-uid' });
}

/** Cheats derived from the real update for this move. */
async function moveCheats(env: Env, doc: ChessDoc, real: ReturnType<typeof moveUpdate>, move: Move): Promise<void> {
  const seat = doc.currentTurn;
  const other: 'host' | 'guest' = seat === 'host' ? 'guest' : 'host';
  const me = env.dbFor[seat];
  const color = colorOf(seat);
  const from = squareName(move.from);
  const to = squareName(move.to);
  const board = real.board;
  const edit = (change: Partial<typeof real> | Data) => ({ ...real, ...change }) as Data;

  await env.expectDenied('move out of turn', env.dbFor[other], real as unknown as Data);
  await env.expectDenied('a stranger moves', env.stranger, real as unknown as Data);
  await env.expectDenied('leave the piece on its square too', me, edit({ board: { ...board, [from]: doc.board[from] } }));
  await env.expectDenied('turn the piece into a queen', me, edit({ board: { ...board, [to]: board[to] === `${color}q` ? `${color}r` : `${color}q` } }));
  const bystander = Object.keys(doc.board).find((sq) => doc.board[sq] !== '' && doc.board[sq][0] !== color && sq !== to && !real.lastMove.extra.includes(sq));
  if (bystander) {
    await env.expectDenied('remove another piece on the side', me, edit({ board: { ...board, [bystander]: '' } }));
    await env.expectDenied('list the removed piece as part of the move', me, edit({ board: { ...board, [bystander]: '' }, lastMove: { ...real.lastMove, extra: [...real.lastMove.extra, bystander].slice(-2) } }));
  }
  const theirs = Object.keys(doc.board).find((sq) => doc.board[sq] !== '' && doc.board[sq][0] !== color && doc.board[sq][1] !== 'k');
  const empty = Object.keys(doc.board).find((sq) => doc.board[sq] === '');
  if (theirs && empty) {
    await env.expectDenied("move the opponent's piece", me, edit({
      board: { ...doc.board, [theirs]: '', [empty]: doc.board[theirs] },
      lastMove: { from: theirs, to: empty, promotion: '', extra: [] },
    }));
  }
  const ownOther = Object.keys(doc.board).find((sq) => doc.board[sq] !== '' && doc.board[sq][0] === color && sq !== from);
  if (ownOther) {
    await env.expectDenied('capture your own piece', me, edit({
      board: { ...doc.board, [from]: '', [ownOther]: doc.board[from] },
      lastMove: { from, to: ownOther, promotion: '', extra: [] },
    }));
  }
  const king = Object.keys(doc.board).find((sq) => doc.board[sq] === `${color === 'w' ? 'b' : 'w'}k`)!;
  await env.expectDenied('capture the king', me, edit({
    board: { ...doc.board, [from]: '', [king]: doc.board[from] },
    lastMove: { from, to: king, promotion: '', extra: [] },
  }));
  if (!move.promotion) {
    await env.expectDenied('promote a piece that is not a pawn on the last rank', me, edit({
      board: { ...board, [to]: `${color}q` },
      lastMove: { ...real.lastMove, promotion: 'q' },
    }));
  }
  await env.expectDenied('promote to a king', me, edit({ board: { ...board, [to]: `${color}k` }, lastMove: { ...real.lastMove, promotion: 'k' } }));
  await env.expectDenied('rewrite the position before the move', me, edit({ prevBoard: board }));
  await env.expectDenied('rewrite the castling rights before the move', me, edit({ prevCastling: doc.castling === '' ? 'KQkq' : '' }));
  await env.expectDenied('rewrite the en passant square before the move', me, edit({ prevEnPassant: doc.enPassant === 'a3' ? 'h6' : 'a3' }));
  await env.expectDenied('keep the turn', me, edit({ currentTurn: seat }));
  await env.expectDenied('skip a move number', me, edit({ moveCount: doc.moveCount + 2 }));
  await env.expectDenied('name the opponent the winner', me, edit({ status: 'won', winner: other }));
  if (real.status === 'playing') await env.expectDenied('name a winner while play goes on', me, edit({ winner: seat }));
  await env.expectDenied('add a square to the board', me, edit({ board: { ...board, z9: 'wq' } }));
  await env.expectDenied('add a field to the move', me, edit({ lastMove: { ...real.lastMove, note: '!!' } }));
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
    const moves = legalMoves(positionOf(doc));
    const move = moves[Math.floor(random() * moves.length)];
    const real = moveUpdate(doc, move);
    await moveCheats(env, doc, real, move);

    if (plies === 4 && !illegalCaught) {
      // A rook-like slide by a knight: consistent with the rules, not legal chess.
      const knight = Object.keys(doc.board).find((sq) => doc.board[sq] === `${colorOf(doc.currentTurn)}n`);
      const empty = knight && Object.keys(doc.board).find((sq) => doc.board[sq] === '' && !legalMoves(positionOf(doc)).some((m) => m.from === squareOf(knight) && m.to === squareOf(sq)));
      if (knight && empty) {
        const forged = { ...real, board: { ...doc.board, [knight]: '', [empty]: doc.board[knight] }, lastMove: { from: knight, to: empty, promotion: '', extra: [] }, castling: doc.castling, enPassant: '', status: 'playing', winner: '' };
        if (!(await env.expectAllowed('an illegal knight move (rules cannot see geometry)', env.dbFor[doc.currentTurn], forged))) break;
        if (verifyMove(env.stored())) env.failures.push('replay missed an illegal move');
        else illegalCaught = true;
        continue;
      }
    }
    if (!(await env.expectAllowed(`ply ${plies + 1} ${squareName(move.from)}-${squareName(move.to)}`, env.dbFor[doc.currentTurn], real))) break;
    if (!verifyMove(env.stored())) env.failures.push(`ply ${plies + 1}: replay disagrees with a real move`);
  }
  return { plies, illegalCaught, failures: env.failures };
}

/** Fool's mate, then a false mate claim and a resignation on a fresh board. */
async function mates(): Promise<string[]> {
  const env = setup(99);
  await createAndJoin(env);
  for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
    const doc = env.stored();
    const update = moveUpdate(doc, { from: squareOf(from), to: squareOf(to) });
    if (!(await env.expectAllowed(`${from}-${to}`, env.dbFor[doc.currentTurn], update))) return env.failures;
  }
  const mated = env.stored();
  if (mated.status !== 'won' || mated.winner !== 'guest') env.failures.push(`fool's mate stored ${mated.status}/${mated.winner}`);
  if (!verifyMove(mated)) env.failures.push("replay rejected fool's mate");

  const other = setup(98);
  await createAndJoin(other);
  const doc = other.stored();
  const claim = { ...moveUpdate(doc, { from: squareOf('e2'), to: squareOf('e4') }), status: 'won', winner: 'host' };
  if (!(await other.expectAllowed('a false checkmate claim (rules cannot see mate)', other.dbFor.host, claim))) return [...env.failures, ...other.failures];
  if (verifyMove(other.stored())) other.failures.push('replay missed a false checkmate claim');

  // Castling and en passant, with their extra squares named wrongly first.
  const special = setup(96);
  await createAndJoin(special);
  const play = async (env: Env, from: string, to: string, before?: (update: ReturnType<typeof moveUpdate>) => Promise<void>) => {
    const doc = env.stored();
    const update = moveUpdate(doc, { from: squareOf(from), to: squareOf(to) });
    await before?.(update);
    if (await env.expectAllowed(`${from}-${to}`, env.dbFor[doc.currentTurn], update) && !verifyMove(env.stored())) {
      env.failures.push(`replay rejected ${from}-${to}`);
    }
  };
  for (const [from, to] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5']]) await play(special, from, to);
  {
    // A knight "castling": it lands on g1 and the h1 rook jumps to f1 as if the king had castled.
    const doc = special.stored();
    const knight = moveUpdate(doc, { from: squareOf('f3'), to: squareOf('g1') });
    await special.expectDenied('castle with a knight', special.dbFor.host, {
      ...knight, board: { ...knight.board, h1: '', f1: 'wr' }, lastMove: { ...knight.lastMove, extra: ['f1', 'h1'] },
    });
  }
  await play(special, 'e1', 'g1', async (castle) => {
    if (JSON.stringify(castle.lastMove.extra) !== JSON.stringify(['f1', 'h1'])) special.failures.push(`castling extra ${castle.lastMove.extra}`);
    await special.expectDenied('castle naming the wrong rook squares', special.dbFor.host, { ...castle, lastMove: { ...castle.lastMove, extra: ['a1', 'd1'] } });
    await special.expectDenied('castle and remove a black piece', special.dbFor.host, {
      ...castle, board: { ...castle.board, h1: 'wr', f1: '', e5: '' }, lastMove: { ...castle.lastMove, extra: ['e5', 'h1'] },
    });
  });
  {
    // A king stepping h1-g1 names f1 and h1 as castling squares to delete a black piece on f1.
    const seeded = setup(93);
    await createAndJoin(seeded);
    const empty = Object.fromEntries(Object.keys(seeded.stored().board).map((sq) => [sq, '']));
    const board = { ...empty, h1: 'wk', f1: 'bn', e8: 'bk' };
    seeded.sandbox.admin.setDocument(seeded.path, { ...seeded.stored(), board, prevBoard: board, castling: '', prevCastling: '', moveCount: 20 } as unknown as Data);
    const doc = seeded.stored();
    const step = moveUpdate(doc, { from: squareOf('h1'), to: squareOf('g1') });
    await seeded.expectDenied('castle from a square the king never started on', seeded.dbFor.host, {
      ...step, board: { ...step.board, f1: '' }, lastMove: { ...step.lastMove, extra: ['f1', 'h1'] },
    });
    special.failures.push(...seeded.failures);
  }
  {
    // Promotions on the last rank: only a pawn promotes, and only to q, r, b or n.
    const promo = setup(91);
    await createAndJoin(promo);
    const empty = Object.fromEntries(Object.keys(promo.stored().board).map((sq) => [sq, '']));
    const board = { ...empty, e1: 'wk', h5: 'bk', a7: 'wr', b7: 'wp' };
    promo.sandbox.admin.setDocument(promo.path, { ...promo.stored(), board, prevBoard: board, castling: '', prevCastling: '', moveCount: 40 } as unknown as Data);
    const doc = promo.stored();
    const rookUp = moveUpdate(doc, { from: squareOf('a7'), to: squareOf('a8') });
    await promo.expectDenied('promote a rook on the last rank', promo.dbFor.host, {
      ...rookUp, board: { ...rookUp.board, a8: 'wq' }, lastMove: { ...rookUp.lastMove, promotion: 'q' },
    });
    const pawnUp = moveUpdate(doc, { from: squareOf('b7'), to: squareOf('b8'), promotion: 'q' });
    await promo.expectDenied('promote a pawn to a king', promo.dbFor.host, {
      ...pawnUp, board: { ...pawnUp.board, b8: 'wk' }, lastMove: { ...pawnUp.lastMove, promotion: 'k' },
    });
    await promo.expectDenied('promote a pawn to a pawn', promo.dbFor.host, {
      ...pawnUp, board: { ...pawnUp.board, b8: 'wp' }, lastMove: { ...pawnUp.lastMove, promotion: 'p' },
    });
    await promo.expectAllowed('promote a pawn to a queen', promo.dbFor.host, pawnUp);
    if (!verifyMove(promo.stored())) promo.failures.push('replay rejected a real promotion');
    special.failures.push(...promo.failures);
  }
  const queenside = setup(92);
  await createAndJoin(queenside);
  for (const [from, to] of [['d2', 'd4'], ['d7', 'd5'], ['b1', 'c3'], ['b8', 'c6'], ['c1', 'f4'], ['c8', 'f5'], ['d1', 'd2'], ['d8', 'd7']]) await play(queenside, from, to);
  await play(queenside, 'e1', 'c1', async (castle) => {
    if (JSON.stringify(castle.lastMove.extra) !== JSON.stringify(['a1', 'd1'])) queenside.failures.push(`queenside extra ${castle.lastMove.extra}`);
    await queenside.expectDenied('castle queenside and remove a black piece', queenside.dbFor.host, {
      ...castle, board: { ...castle.board, a1: 'wr', d1: '', d5: '' }, lastMove: { ...castle.lastMove, extra: ['a1', 'd5'] },
    });
  });
  special.failures.push(...queenside.failures);
  const passant = setup(95);
  await createAndJoin(passant);
  for (const [from, to] of [['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']]) await play(passant, from, to);
  await play(passant, 'e5', 'd6', async (capture) => {
    if (JSON.stringify(capture.lastMove.extra) !== JSON.stringify(['d5'])) passant.failures.push(`en passant extra ${capture.lastMove.extra}`);
    await passant.expectDenied('en passant naming a different captured square', passant.dbFor.host, {
      ...capture, board: { ...capture.board, d5: 'bp', a6: '' }, lastMove: { ...capture.lastMove, extra: ['a6'] },
    });
  });
  const lateCapture = setup(94);
  await createAndJoin(lateCapture);
  for (const [from, to] of [['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5'], ['b1', 'c3'], ['a6', 'a5']]) await play(lateCapture, from, to);
  {
    // The d5 pawn can no longer be taken en passant: the move after has passed.
    const doc = lateCapture.stored();
    const real = moveUpdate(doc, { from: squareOf('e5'), to: squareOf('e6') });
    await lateCapture.expectDenied('en passant a move too late', lateCapture.dbFor.host, {
      ...real, board: { ...real.board, e6: '', d6: 'wp', d5: '' }, lastMove: { from: 'e5', to: 'd6', promotion: '', extra: ['d5'] },
    });
  }

  const third = setup(97);
  await createAndJoin(third);
  await third.expectDenied('a stranger resigns the match', third.stranger, { status: 'resigned', winner: 'host' });
  await third.expectDenied('black resigns for white', third.dbFor.guest, { status: 'resigned', winner: 'guest' });
  await third.expectAllowed('black resigns', third.dbFor.guest, { status: 'resigned', winner: 'host' });
  return [...env.failures, ...other.failures, ...special.failures, ...passant.failures, ...lateCapture.failures, ...third.failures];
}

describe('Chess Security Rules', () => {
  test('real moves allowed, cheats denied, illegal moves caught by replay', async () => {
    // CHESS_PROBE runs one short game; every cheat still runs before every move.
    const probe = process.env.CHESS_PROBE === '1';
    const results = [];
    for (const seed of probe ? [1] : [1, 2, 3]) results.push(await playGame(seed, probe ? 10 : 40));
    const failures = results.flatMap((r, i) => r.failures.map((f) => `game ${i + 1}: ${f}`));
    expect(failures.slice(0, 20)).toEqual([]);
    expect(results.some((r) => r.illegalCaught)).toBe(true);
  }, 900_000);

  test('checkmate, castling, en passant, a false mate claim, and resignation', async () => {
    expect(await mates()).toEqual([]);
  }, 300_000);
});
