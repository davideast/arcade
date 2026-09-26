/**
 * Uno Security Rules against Pyric's sandbox. Seeded games with 2, 3 and 4
 * players run through the same write lists the browser applies, each write as
 * the acting player's identity. Every real action must be allowed; before each
 * one, a set of cheats derived from it must be denied and leave nothing changed.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { mulberry32 } from '@games/harness';
import { COLORS, canPlay, isWild, shuffledDeck, type Card } from './cards.ts';
import {
  afterPlay,
  createdMatch,
  dealOps,
  deckOps,
  drawOps,
  joinOps,
  matchPath,
  playOps,
  startOps,
  type UnoMatch,
  type WriteOp,
} from './logic.ts';

const rules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();

type Db = ReturnType<typeof getFirestore>;

async function apply(db: Db, ops: WriteOp[]): Promise<void> {
  const batch = db.batch();
  for (const op of ops) {
    const ref = db.doc(op.path);
    if (op.type === 'set') batch.set(ref, op.data);
    else batch.update(ref, op.data);
  }
  await batch.commit();
}

async function denied(db: Db, ops: WriteOp[]): Promise<boolean> {
  try {
    await apply(db, ops);
    return false;
  } catch (e) {
    return (e as { code?: string }).code === 'permission-denied';
  }
}

interface GameResult {
  moves: number;
  failures: string[];
  winner: string;
}

async function playGame(seed: number, playerCount: number): Promise<GameResult> {
  const random = mulberry32(seed);
  const sandbox = initializeSandbox();
  const admin = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
  admin.setRules(rules);
  const uids = Array.from({ length: playerCount }, (_, i) => `player-${i}`);
  const dbs = new Map(uids.map((uid) => [uid, getFirestore(sandbox.withAuth({ uid }))]));
  const as = (uid: string) => dbs.get(uid)!;
  const stranger = getFirestore(sandbox.withAuth({ uid: 'stranger' }));
  const failures: string[] = [];
  const expectDenied = async (label: string, db: Db, ops: WriteOp[]) => {
    const before = JSON.stringify(sandbox.admin.getDocument(matchPath(id)));
    if (!(await denied(db, ops))) failures.push(`allowed: ${label}`);
    if (JSON.stringify(sandbox.admin.getDocument(matchPath(id))) !== before) failures.push(`changed state: ${label}`);
  };
  const expectAllowed = async (label: string, db: Db, ops: WriteOp[]) => {
    try {
      await apply(db, ops);
      return true;
    } catch (e) {
      failures.push(`denied: ${label} (${(e as Error).message})`);
      return false;
    }
  };

  const id = `m${seed}`;
  const host = uids[0];
  await expectAllowed('create', as(host), [{ type: 'set', path: matchPath(id), data: { ...createdMatch(host), createdAt: FieldValue.serverTimestamp() } }]);
  let m = createdMatch(host);
  for (const uid of uids.slice(1)) {
    await expectDenied('non-host starts', as(uid), startOps(id, { ...m, players: [host, uid] }));
    await expectAllowed(`join ${uid}`, as(uid), joinOps(id, m, uid));
    m = { ...m, players: [...m.players, uid], counts: [...m.counts, 0] };
  }
  await expectDenied('join twice', as(uids[1]), [{ type: 'update', path: matchPath(id), data: { players: [...m.players, uids[1]], counts: [...m.counts, 0], lastAction: 'join' } }]);
  await expectAllowed('start', as(host), startOps(id, m));
  m = { ...m, status: 'dealing' };
  await expectDenied('join after start', stranger, [{ type: 'update', path: matchPath(id), data: { players: [...m.players, 'stranger'], counts: [...m.counts, 0], lastAction: 'join' } }]);

  const deck = shuffledDeck(random, playerCount);
  await expectDenied('non-host writes the deck', as(uids[1]), deckOps(id, deck).slice(0, 1));
  await expectAllowed('deck', as(host), deckOps(id, deck));
  const dealBad = dealOps(id, m, deck);
  (dealBad[dealBad.length - 1] as { data: Record<string, unknown> }).data.counts = m.players.map(() => 6);
  await expectDenied('deal six cards', as(host), dealBad);
  const dealt = dealOps(id, m, deck);
  const k = playerCount * 7;
  await expectDenied("deal a card into another player's hand", as(host), dealt.map((op, i) => i === 0 ? { ...op, data: { uid: m.players[1] } } : op));
  await expectDenied('deal the opening card into the host hand', as(host), [{ type: 'set', path: `${matchPath(id)}/draws/${k}`, data: { uid: host } }, ...dealt]);
  await expectDenied("mark a card in a player's hand as played", as(host), [{ type: 'set', path: `${matchPath(id)}/played/1`, data: { by: host } }, ...dealt]);
  await expectAllowed('deal', as(host), dealt);

  const draws = new Map<number, string>();
  for (let i = 0; i < playerCount * 7; i++) draws.set(i, m.players[i % playerCount]);
  const played = new Set<number>([playerCount * 7]);
  const top = deck[playerCount * 7];
  m = { ...m, status: 'playing', counts: m.players.map(() => 7), turn: 0, direction: 1, color: top[0], value: top.slice(1), pending: 0, drawIndex: playerCount * 7 + 1, lastCard: playerCount * 7, lastAction: 'deal' };

  const hand = (uid: string) => [...draws].filter(([i, who]) => who === uid && !played.has(i)).map(([i]) => i);
  const opponent = (uid: string) => m.players.find((p) => p !== uid)!;

  // Reads: your own card, not someone else's.
  const mine = hand(host)[0];
  try {
    await as(host).doc(`${matchPath(id)}/deck/${mine}`).get();
  } catch {
    failures.push('denied: reading your own card');
  }
  try {
    await as(uids[1]).doc(`${matchPath(id)}/deck/${mine}`).get();
    failures.push("allowed: reading another player's card");
  } catch { /* denied */ }

  let moves = 0;
  while (m.status === 'playing' && moves < 400) {
    const uid = m.players[m.turn];
    const other = opponent(uid);
    const cards = hand(uid);
    const legal = m.pending > 0 ? [] : cards.filter((i) => canPlay(deck[i], m.color, m.value));
    const chosen = COLORS[Math.floor(random() * 4)];

    // Cheats, each derived from the real position.
    const theirs = hand(other).find((i) => canPlay(deck[i], m.color, m.value));
    if (theirs !== undefined && m.pending === 0) {
      await expectDenied("play a card from another player's hand", as(uid), playOps(id, m, theirs, deck[theirs], isWild(deck[theirs]) ? chosen : undefined));
    }
    const illegal = cards.find((i) => !canPlay(deck[i], m.color, m.value));
    if (illegal !== undefined && m.pending === 0) {
      const next = afterPlay({ ...m, color: deck[illegal][0], value: deck[illegal].slice(1) }, illegal, deck[illegal], isWild(deck[illegal]) ? chosen : undefined);
      await expectDenied('play a card that does not match', as(uid), [
        { type: 'set', path: `${matchPath(id)}/played/${illegal}`, data: { by: uid } },
        { type: 'update', path: matchPath(id), data: { counts: next.counts, direction: next.direction, turn: next.turn, color: next.color, value: next.value, pending: next.pending, lastCard: illegal, lastAction: 'play', moveCount: next.moveCount, status: next.status, winner: next.winner } },
      ]);
    }
    await expectDenied('replay the top card', as(uid), [
      { type: 'set', path: `${matchPath(id)}/played/${m.lastCard}`, data: { by: uid } },
      { type: 'update', path: matchPath(id), data: { lastCard: m.lastCard, lastAction: 'play', moveCount: m.moveCount + 1, counts: m.counts.map((c, k) => (k === m.turn ? c - 1 : c)) } },
    ]);
    // A penalty must be drawn; playing a matching card instead is a cheat.
    const dodge = m.pending > 0 ? cards.find((i) => canPlay(deck[i], m.color, m.value)) : undefined;
    if (dodge !== undefined) {
      const color = isWild(deck[dodge]) ? chosen : undefined;
      const open = { ...m, pending: 0 };
      const ops = playOps(id, open, dodge, deck[dodge], color);
      const update = ops[1] as { type: 'update'; path: string; data: Record<string, unknown> };
      await expectDenied('play a card instead of drawing the penalty', as(uid), [
        ops[0],
        { ...update, data: { ...update.data, pending: afterPlay(open, dodge, deck[dodge], color).pending } },
      ]);
    }
    // A card this player already played still has its played doc, so the match
    // update alone would pass the played-doc check.
    const replay = [...played].find((i) => draws.get(i) === uid && canPlay(deck[i], m.color, m.value));
    if (replay !== undefined && m.pending === 0) {
      await expectDenied('replay an already played card with only the match update', as(uid), [
        playOps(id, m, replay, deck[replay], isWild(deck[replay]) ? chosen : undefined)[1],
      ]);
    }
    const outOfTurn = hand(other).find((i) => canPlay(deck[i], m.color, m.value));
    if (outOfTurn !== undefined && m.pending === 0) {
      await expectDenied('play out of turn', as(other), playOps(id, { ...m, turn: m.players.indexOf(other) }, outOfTurn, deck[outOfTurn], isWild(deck[outOfTurn]) ? chosen : undefined));
    }

    if (legal.length > 0) {
      const index = legal[Math.floor(random() * legal.length)];
      const card = deck[index];
      const color = isWild(card) ? chosen : undefined;
      const ops = playOps(id, m, index, card, color);
      const update = ops[1] as { data: Record<string, unknown> };
      await expectDenied('play without taking the card from the count', as(uid), [ops[0], { ...ops[1], data: { ...update.data, counts: m.counts } }]);
      const correct = afterPlay(m, index, card, color).turn;
      await expectDenied('play and move the turn to the wrong seat', as(uid), [ops[0], { ...ops[1], data: { ...update.data, turn: (correct + 1) % playerCount } }]);
      if (isWild(card)) await expectDenied('play a wild without a color', as(uid), [ops[0], { ...ops[1], data: { ...update.data, color: 'x' } }]);
      if (card.slice(1) === 'd' || card.slice(1) === '+') await expectDenied('play a draw card without the penalty', as(uid), [ops[0], { ...ops[1], data: { ...update.data, pending: 0 } }]);
      if (!(await expectAllowed(`play ${card}`, as(uid), ops))) break;
      played.add(index);
      m = afterPlay(m, index, card, color);
    } else {
      const ops = drawOps(id, m);
      const k = m.pending > 0 ? m.pending : 1;
      if (m.pending > 0) {
        const short = drawOps(id, { ...m, pending: 0 });
        await expectDenied(`draw one card instead of ${k}`, as(uid), short);
      }
      const last = ops[ops.length - 1] as { type: 'update'; path: string; data: Record<string, unknown> };
      if (m.drawIndex + k < 108) {
        await expectDenied('draw and skip the next card in the deck', as(uid), [
          ...ops.slice(0, -1),
          { ...last, data: { ...last.data, drawIndex: (last.data.drawIndex as number) + 1 } },
        ]);
      }
      if (!(await expectAllowed(`draw ${k}`, as(uid), ops))) break;
      for (let i = m.drawIndex; i < m.drawIndex + k && i < 108; i++) draws.set(i, uid);
      const counts = m.counts.slice();
      const available = Math.min(k, 108 - m.drawIndex);
      counts[m.turn] += available;
      m = { ...m, counts, pending: 0, drawIndex: m.drawIndex + available, turn: (m.turn + m.direction + playerCount) % playerCount, lastAction: available > 0 ? 'draw' : 'pass', moveCount: m.moveCount + 1 };
    }
    moves++;
    const stored = sandbox.admin.getDocument(matchPath(id)) as Record<string, unknown>;
    for (const key of ['turn', 'direction', 'color', 'value', 'pending', 'drawIndex', 'status', 'winner'] as const) {
      if (JSON.stringify(stored[key]) !== JSON.stringify(m[key])) failures.push(`move ${moves}: stored ${key} ${JSON.stringify(stored[key])}, expected ${JSON.stringify(m[key])}`);
    }
  }
  return { moves, failures, winner: m.winner };
}

describe('Uno Security Rules', () => {
  for (const players of (process.env.UNO_PLAYERS ?? '2,3,4').split(',').map(Number)) {
    test(`${players} players: every real action allowed, every cheat denied`, async () => {
      const results = [];
      // Every write re-parses the ruleset in the sandbox (bug 0007), so 3 and 4 players run one game each.
      const seeds = players === 2 ? [1, 2, 3] : [1];
      for (const seed of seeds) results.push(await playGame(seed * 10 + players, players));
      const failures = results.flatMap((r, i) => r.failures.map((f) => `seed ${i}: ${f}`));
      expect(failures.slice(0, 20)).toEqual([]);
      expect(results.every((r) => r.moves > 5)).toBe(true);
    }, 600_000);
  }
});
