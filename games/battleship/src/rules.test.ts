/**
 * Battleship Security Rules against Pyric's sandbox. Seeded games place random
 * fleets and fire at random cells through the same write lists the browser
 * applies; every real action must be allowed, and before each one a set of
 * cheats derived from it must be denied and leave the match unchanged.
 * Reads check that a fleet stays private until the match ends.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FieldValue, getFirestore } from 'pyric-admin/firestore';
import { mulberry32 } from '@games/harness';
import {
  FLEET_CELLS,
  afterShot,
  boardDoc,
  createdMatch,
  joinOps,
  matchPath,
  randomFleet,
  readyOps,
  shotId,
  shotOps,
  type BattleshipMatch,
  type Placement,
  type WriteOp,
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

async function denied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (e) {
    return (e as { code?: string }).code === 'permission-denied';
  }
}

/** Replace the data of the op at `index`. */
function edit(ops: WriteOp[], index: number, change: (data: Data) => Data): WriteOp[] {
  return ops.map((op, i) => (i === index ? { ...op, data: change(op.data) } : op));
}

async function playGame(seed: number, fullGame: boolean): Promise<{ shots: number; failures: string[]; winner: string }> {
  const random = mulberry32(seed);
  const sandbox = initializeSandbox();
  getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } })).setRules(rules);
  const host = getFirestore(sandbox.withAuth({ uid: 'host-uid' }));
  const guest = getFirestore(sandbox.withAuth({ uid: 'guest-uid' }));
  const stranger = getFirestore(sandbox.withAuth({ uid: 'stranger-uid' }));
  const dbFor = { host, guest };
  const id = `m${seed}`;
  const failures: string[] = [];
  const snapshot = () => JSON.stringify([sandbox.admin.getDocument(matchPath(id)), sandbox.admin.listDocuments(`${matchPath(id)}/`)]);
  const expectDenied = async (label: string, db: Db, ops: WriteOp[]) => {
    const before = snapshot();
    if (!(await denied(() => apply(db, ops)))) failures.push(`allowed: ${label}`);
    if (snapshot() !== before) failures.push(`changed state: ${label}`);
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
  const readDenied = async (label: string, db: Db, path: string) => {
    if (!(await denied(() => db.doc(path).get()))) failures.push(`read allowed: ${label}`);
  };
  const readAllowed = async (label: string, db: Db, path: string) => {
    try {
      await db.doc(path).get();
    } catch (e) {
      failures.push(`read denied: ${label} (${(e as Error).message})`);
    }
  };

  // Create and join.
  const fresh = createdMatch('host-uid') as unknown as Data & BattleshipMatch;
  const create = (data: Data): WriteOp[] => [{ type: 'set', path: matchPath(id), data: { ...data, createdAt: FieldValue.serverTimestamp() } }];
  await expectDenied('create with hits already scored', host, create({ ...fresh, hostHits: 3 }));
  await expectDenied('create already placing', host, create({ ...fresh, status: 'placing' }));
  await expectDenied('create ready', host, create({ ...fresh, hostReady: true }));
  await expectDenied('create for someone else', stranger, create(fresh));
  await expectDenied('create with an extra field', host, create({ ...fresh, extra: 1 }));
  await expectDenied('create with the guest already seated', host, create({ ...fresh, guest: 'guest-uid' }));
  await expectDenied('create with a shot already named', host, create({ ...fresh, lastShot: 'h00' }));
  await expectDenied('create as the second shooter', host, create({ ...fresh, currentTurn: 'guest' }));
  await expectDenied('create with a winner', host, create({ ...fresh, winner: 'host' }));
  await expectDenied('create with a move made', host, create({ ...fresh, moveCount: 1 }));
  await expectDenied('create with the guest ready', host, create({ ...fresh, guestReady: true }));
  await expectDenied('create with guest hits', host, create({ ...fresh, guestHits: 2 }));
  await expectDenied('create with a client clock', host, [{ type: 'set', path: matchPath(id), data: { ...fresh, createdAt: new Date(0) } }]);
  await expectAllowed('create', host, create(fresh));
  await expectDenied('host joins their own match', host, joinOps(id, 'host-uid'));
  await expectDenied('join straight into battle', guest, [{ type: 'update', path: matchPath(id), data: { guest: 'guest-uid', status: 'playing' } }]);
  await expectDenied('place a fleet before anyone joins', host, [
    { type: 'set', path: `${matchPath(id)}/boards/host-uid`, data: boardDoc(randomFleet(mulberry32(seed + 100))) as unknown as Data },
  ]);
  await expectDenied('seat someone else as the guest', guest, joinOps(id, 'stranger-uid'));
  await expectDenied('join and change a field', guest, [{ type: 'update', path: matchPath(id), data: { guest: 'guest-uid', status: 'placing', hostHits: 5 } }]);
  await expectAllowed('join', guest, joinOps(id, 'guest-uid'));
  await expectDenied('join a full match', stranger, joinOps(id, 'stranger-uid'));
  let m: BattleshipMatch = { ...fresh, guest: 'guest-uid', status: 'placing' };

  // Place fleets.
  const fleets: Record<'host' | 'guest', Placement[]> = { host: randomFleet(random), guest: randomFleet(random) };
  const hostReady = readyOps(id, m, 'host', fleets.host);
  const withBoard = (ops: WriteOp[], board: Data) => edit(ops, 0, () => board);
  const board = boardDoc(fleets.host) as unknown as Data;
  const cells = board.cells as number[];
  const starts = board.starts as number[];
  await expectDenied('ready without a fleet', host, hostReady.slice(1));
  await expectDenied('a stranger writes a fleet', stranger, [
    { type: 'set', path: `${matchPath(id)}/boards/stranger-uid`, data: boardDoc(fleets.host) as unknown as Data },
  ]);
  await expectDenied('a stranger places a fleet and readies', stranger, [
    { type: 'set', path: `${matchPath(id)}/boards/stranger-uid`, data: boardDoc(fleets.host) as unknown as Data },
    { type: 'update', path: matchPath(id), data: { guestReady: true, status: 'placing' } },
  ]);
  await expectDenied('a fleet missing a ship', host, withBoard(hostReady, { ...board, starts: starts.slice(0, 4), dirs: (board.dirs as string[]).slice(0, 4), cells: cells.slice(0, 15) }));
  const decoyCell = Array.from({ length: 100 }, (_, c) => c).find((c) => !cells.includes(c))!;
  await expectDenied('a fleet with cells that are not its ships', host, withBoard(hostReady, { ...board, cells: [...cells.slice(0, 16), decoyCell] }));
  await expectDenied('two ships on the same cells', host, withBoard(hostReady, boardDoc([...fleets.host.slice(0, 3), fleets.host[2], fleets.host[4]]) as unknown as Data));
  await expectDenied('a ship off the edge of the board', host, withBoard(hostReady, { starts: [8, ...starts.slice(1)], dirs: ['h', ...(board.dirs as string[]).slice(1)], cells: [8, 9, 10, 11, 12, ...cells.slice(5)] }));
  await expectDenied('a ship running off the bottom', host, withBoard(hostReady, { starts: [80, ...starts.slice(1)], dirs: ['v', ...(board.dirs as string[]).slice(1)], cells: [80, 90, 100, 110, 120, ...cells.slice(5)] }));
  await expectDenied('a ship laid diagonally', host, withBoard(hostReady, { ...board, dirs: ['d', ...(board.dirs as string[]).slice(1)] }));
  await expectDenied('a fleet with an extra field', host, withBoard(hostReady, { ...board, decoy: [1] }));
  // Ship 0 (length 5) moved somewhere its cells still add up, but the placement itself is off.
  const rest = { starts: starts.slice(1), dirs: (board.dirs as string[]).slice(1), cells: cells.slice(5) };
  const withShip0 = (start: number, dir: string, shipCells: number[]) =>
    withBoard(hostReady, { starts: [start, ...rest.starts], dirs: [dir, ...rest.dirs], cells: [...shipCells, ...rest.cells] });
  const freeColumn = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find((c) => [0, 10, 20].every((r) => !rest.cells.includes(r + c)))!;
  await expectDenied('a ship hanging off the top edge', host, withShip0(freeColumn - 20, 'v', [-20, -10, 0, 10, 20].map((v) => v + freeColumn)));
  await expectDenied('a ship starting past the last cell', host, withShip0(105, 'h', [105, 106, 107, 108, 109]));
  await expectDenied('a ship at a fractional cell', host, withShip0(2.5, 'h', [2.5, 3.5, 4.5, 5.5, 6.5]));
  await expectDenied('a sixth ship start with no ship', host, withBoard(hostReady, { ...board, starts: [...starts, 99] }));
  await expectDenied('a sixth direction with no ship', host, withBoard(hostReady, { ...board, dirs: [...(board.dirs as string[]), 'h'] }));
  const vertical = fleets.host.findIndex((p) => p.dir === 'v');
  if (vertical >= 0) {
    const dirs = (board.dirs as string[]).slice();
    dirs[vertical] = 'x';
    await expectDenied('a ship laid in an unknown direction that steps like a column', host, withBoard(hostReady, { ...board, dirs }));
  }
  await expectDenied('write the opponent\'s fleet', host, [{ type: 'set', path: `${matchPath(id)}/boards/guest-uid`, data: board }]);
  await expectDenied('ready with a head start in hits', host, edit(hostReady, 1, (d) => ({ ...d, hostHits: 3 })));
  await expectDenied('start the battle alone', host, edit(hostReady, 1, (d) => ({ ...d, status: 'playing' })));
  await expectDenied('mark the opponent ready', host, edit(hostReady, 1, () => ({ guestReady: true, status: 'placing' })));
  await expectAllowed('host places a fleet', host, hostReady);
  m = { ...m, hostReady: true };
  await expectDenied('ready a second time', host, hostReady.slice(1));
  await expectDenied('move ships after placing', host, [{ type: 'set', path: `${matchPath(id)}/boards/host-uid`, data: boardDoc(randomFleet(random)) as unknown as Data }]);
  await readDenied('guest reads the host fleet', guest, `${matchPath(id)}/boards/host-uid`);
  await readAllowed('host reads their own fleet', host, `${matchPath(id)}/boards/host-uid`);
  await expectDenied('shoot before the battle starts', host, shotOps(id, { ...m, status: 'playing' }, 0, false));
  await expectDenied('start the battle without marking ready', guest, edit(readyOps(id, m, 'guest', fleets.guest), 1, () => ({ status: 'playing' })));
  await expectAllowed('guest places a fleet', guest, readyOps(id, m, 'guest', fleets.guest));
  m = { ...m, guestReady: true, status: 'playing' };

  // Battle.
  const fleetCells = { host: new Set(boardDoc(fleets.host).cells), guest: new Set(boardDoc(fleets.guest).cells) };
  const fired = { host: new Set<number>(), guest: new Set<number>() };
  let shots = 0;
  const limit = fullGame ? 200 : 12;
  while (m.status === 'playing' && shots < limit) {
    const seat = m.currentTurn;
    const other = seat === 'host' ? 'guest' : 'host';
    const shooter = dbFor[seat];
    // Aim at an unfired cell; in a full game, finish ships quickly by preferring the defender's cells.
    const open = Array.from({ length: 100 }, (_, c) => c).filter((c) => !fired[seat].has(c));
    const targets = fullGame && random() < 0.6 ? open.filter((c) => fleetCells[other].has(c)) : open;
    const cell = (targets.length ? targets : open)[Math.floor(random() * (targets.length ? targets : open).length)];
    const hit = fleetCells[other].has(cell);
    const ops = shotOps(id, m, cell, hit);

    await expectDenied('report a hit as a miss, or a miss as a hit', shooter, shotOps(id, m, cell, !hit));
    await expectDenied('shoot out of turn', dbFor[other], shotOps(id, { ...m, currentTurn: other }, cell, fleetCells[seat].has(cell)));
    await expectDenied('shoot under the other seat\'s name', shooter, edit(shotOps(id, { ...m, currentTurn: other }, cell, fleetCells[seat].has(cell)), 0, (d) => ({ ...d, by: m[seat] })));
    await expectDenied('a stranger shoots', stranger, ops);
    // Named with the other seat's prefix, the shot would take that seat's id for the cell and block it.
    const squat = `${seat === 'host' ? 'g' : 'h'}${String(cell).padStart(2, '0')}`;
    await expectDenied("take the other seat's shot id for the cell", shooter, [
      { ...ops[0], path: `${matchPath(id)}/shots/${squat}` },
      { ...ops[1], data: { ...ops[1].data, lastShot: squat } },
    ]);
    await expectDenied('fire without the match update', shooter, ops.slice(0, 1));
    await expectDenied('update the match without a shot', shooter, ops.slice(1));
    await expectDenied('keep the turn', shooter, edit(ops, 1, (d) => ({ ...d, currentTurn: seat })));
    await expectDenied('score a hit on a miss', shooter, edit(ops, 1, (d) => ({ ...d, [`${seat}Hits`]: (d[`${seat}Hits`] as number) + 1 })));
    if (ops[1].data.status !== 'won') {
      await expectDenied('declare victory', shooter, edit(ops, 1, (d) => ({ ...d, status: 'won', winner: seat })));
      await expectDenied('end the match with no winner', shooter, edit(ops, 1, (d) => ({ ...d, status: 'won' })));
      await expectDenied('name a winner while the battle goes on', shooter, edit(ops, 1, (d) => ({ ...d, winner: seat })));
    }
    await expectDenied('skip a move number', shooter, edit(ops, 1, (d) => ({ ...d, moveCount: m.moveCount + 2 })));
    await expectDenied('change the opponent\'s hits', shooter, edit(ops, 1, (d) => ({ ...d, [`${other}Hits`]: m[`${other}Hits`] + 1 })));
    await expectDenied('shoot off the board', shooter, [
      { type: 'set', path: `${matchPath(id)}/shots/${seat === 'host' ? 'h' : 'g'}100`, data: { by: m[seat], cell: 100, hit: false } },
      { ...ops[1], data: { ...ops[1].data, lastShot: `${seat === 'host' ? 'h' : 'g'}100`, [`${seat}Hits`]: seat === 'host' ? m.hostHits : m.guestHits } },
    ]);
    const second = open.find((c) => c !== cell);
    if (second !== undefined) {
      await expectDenied('fire two shots in one turn', shooter, [
        ...ops,
        { type: 'set', path: `${matchPath(id)}/shots/${shotId(seat, second)}`, data: { by: m[seat], cell: second, hit: fleetCells[other].has(second) } },
      ]);
    }
    const oldHit = [...fired[seat]].find((c) => fleetCells[other].has(c));
    if (oldHit !== undefined) {
      await expectDenied('score an earlier hit again', shooter, [
        { ...ops[1], data: { ...shotOps(id, m, oldHit, true)[1].data } },
      ]);
    }
    const negative = `${seat === 'host' ? 'h' : 'g'}-5`;
    await expectDenied('shoot at a negative cell', shooter, [
      { type: 'set', path: `${matchPath(id)}/shots/${negative}`, data: { by: m[seat], cell: -5, hit: false } },
      { ...ops[1], data: { ...ops[1].data, lastShot: negative, [`${seat}Hits`]: seat === 'host' ? m.hostHits : m.guestHits } },
    ]);
    await expectDenied('name the shot for a different cell', shooter, edit(ops, 0, (d) => ({ ...d, cell: (cell + 1) % 100 })));
    await expectDenied('add a field to the shot', shooter, edit(ops, 0, (d) => ({ ...d, note: 'x' })));
    if (fired[seat].size > 0) {
      const again = [...fired[seat]][0];
      await expectDenied('fire at the same cell twice', shooter, shotOps(id, m, again, fleetCells[other].has(again)));
    }
    await readDenied('read the opponent\'s fleet mid-battle', shooter, `${matchPath(id)}/boards/${m[other]}`);

    if (!(await expectAllowed(`shot ${shots + 1} at ${cell}`, shooter, ops))) break;
    fired[seat].add(cell);
    m = afterShot(m, cell, hit);
    shots++;
    const stored = sandbox.admin.getDocument(matchPath(id)) as Data;
    for (const key of ['currentTurn', 'hostHits', 'guestHits', 'status', 'winner', 'moveCount', 'lastShot'] as const) {
      if (stored[key] !== m[key]) failures.push(`shot ${shots}: stored ${key} ${String(stored[key])}, expected ${String(m[key])}`);
    }
  }
  if (fullGame) {
    if (m.status !== 'won') failures.push(`game did not finish in ${shots} shots`);
    else {
      await readAllowed('loser reads the winner fleet after the match', dbFor[m.winner === 'host' ? 'guest' : 'host'], `${matchPath(id)}/boards/${m[m.winner as 'host' | 'guest']}`);
      await expectDenied('shoot after the match ended', dbFor[m.currentTurn], shotOps(id, { ...m, status: 'playing' }, 0, false));
    }
  } else {
    await expectDenied('a stranger resigns the match', stranger, [{ type: 'update', path: matchPath(id), data: { status: 'resigned', winner: 'host' } }]);
    await expectDenied('resign for the opponent', host, [{ type: 'update', path: matchPath(id), data: { status: 'resigned', winner: 'host' } }]);
    await expectAllowed('resign', host, [{ type: 'update', path: matchPath(id), data: { status: 'resigned', winner: 'guest' } }]);
  }
  return { shots, failures, winner: m.winner };
}

describe('Battleship Security Rules', () => {
  test('placement, shots and fleet privacy: real actions allowed, cheats denied', async () => {
    // BATTLESHIP_PROBE runs one short game; every cheat still runs before every shot.
    const probe = process.env.BATTLESHIP_PROBE === '1';
    const results = [await playGame(1, false)];
    if (!probe) results.push(await playGame(2, true), await playGame(3, true));
    const failures = results.flatMap((r, i) => r.failures.map((f) => `game ${i + 1}: ${f}`));
    expect(failures.slice(0, 20)).toEqual([]);
    if (!probe) expect(results.slice(1).every((r) => r.winner !== '' && r.shots >= FLEET_CELLS)).toBe(true);
  }, 600_000);
});

test('shot ids name the seat and the cell', () => {
  expect(shotId('host', 7)).toBe('h07');
  expect(shotId('guest', 42)).toBe('g42');
});
