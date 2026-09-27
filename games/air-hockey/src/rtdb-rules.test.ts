/**
 * The Realtime Database rules through the ruleset handle Pyric's constraint
 * builders produce: `lint()` and `simulate(cases)` on the TypeScript
 * definition, with no sandbox. rules.test.ts plays whole matches through
 * the sandbox; this checks one write of each kind against a fixed tree.
 */
import { describe, expect, test } from 'bun:test';
import type { RtdbCase } from 'pyric/rules';
import { airHockeyRtdbRules } from './rtdb-rules.ts';
import { frameOf } from './logic.ts';
import { initialWorld } from './physics.ts';

const M = '/airhockey/m1/host-uid';
const frame = frameOf(initialWorld());
const playing = {
  airhockey: {
    m1: {
      'host-uid': {
        meta: { guest: 'guest-uid', status: 'playing', winner: '' },
        frame,
        score: { host: 6, guest: 3 },
        presence: { host: true, guest: false },
      },
    },
  },
};
const over = structuredClone(playing);
over.airhockey.m1['host-uid'].meta.status = 'over';

type Expect = 'ALLOW' | 'DENY';
const write = (description: string, expectation: Expect, auth: string | null, path: string, newData: unknown, data: Record<string, unknown> = playing): RtdbCase =>
  ({ description, expectation, operation: 'write', path: `${M}${path}`, auth, data, newData });
const read = (description: string, expectation: Expect, auth: string | null, path = ''): RtdbCase =>
  ({ description, expectation, operation: 'read', path: `${M}${path}`, auth, data: playing });

describe('Air Hockey Realtime Database rules (TypeScript definition)', () => {
  test("lint finds no errors; its warnings are the root's deny-all rules", () => {
    const issues = airHockeyRtdbRules.lint();
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    // The root's `.read` and `.write` are `false` on purpose.
    const warned = issues.map((i) => `${i.code} ${i.path}`).sort();
    expect(warned).toEqual(['HARDCODED_FALSE /', 'HARDCODED_FALSE /']);
  });

  test('simulate: one write of each kind', () => {
    const next = { ...frame, puck: { ...frame.puck, t: 3 } };
    const cases: RtdbCase[] = [
      read('the host reads the match', 'ALLOW', 'host-uid'),
      read('the guest reads the match', 'ALLOW', 'guest-uid'),
      read('a stranger reads the match', 'DENY', 'stranger-uid'),
      read('a signed-out reader', 'DENY', null),
      write('the host writes a frame', 'ALLOW', 'host-uid', '/frame', next),
      write('the guest writes a frame', 'DENY', 'guest-uid', '/frame', next),
      write('a frame at the stored tick', 'DENY', 'host-uid', '/frame', frame),
      write('a frame with the puck off the table', 'DENY', 'host-uid', '/frame', { ...next, puck: { ...next.puck, x: 97 } }),
      write('a frame with the host mallet in the guest half', 'DENY', 'host-uid', '/frame', { ...next, host: { x: 48, y: 60 } }),
      write('the host moves the puck without a new tick', 'DENY', 'host-uid', '/frame/puck/x', 50),
      write('the host moves the puck off the table', 'DENY', 'host-uid', '/frame/puck/x', 100),
      write('the guest moves its mallet', 'ALLOW', 'guest-uid', '/guestMallet', { x: 20, y: 30 }),
      write('the host moves the guest mallet', 'DENY', 'host-uid', '/guestMallet', { x: 20, y: 30 }),
      write('the guest mallet in the host half', 'DENY', 'guest-uid', '/guestMallet', { x: 20, y: 70 }),
      write('a goal for the host with the match closed', 'DENY', 'host-uid', '/score', { host: 7, guest: 3 }),
      write('a goal for the guest', 'ALLOW', 'host-uid', '/score', { host: 6, guest: 4 }),
      write('a score jump of two', 'DENY', 'host-uid', '/score', { host: 6, guest: 5 }),
      write('the guest scores', 'DENY', 'guest-uid', '/score', { host: 6, guest: 4 }),
      write('the host claims the forfeit of the absent guest', 'ALLOW', 'host-uid', '/meta', { guest: 'guest-uid', status: 'forfeit', winner: 'host' }),
      write('the guest claims a forfeit of the present host', 'DENY', 'guest-uid', '/meta', { guest: 'guest-uid', status: 'forfeit', winner: 'guest' }),
      write('the guest resigns', 'ALLOW', 'guest-uid', '/meta', { guest: 'guest-uid', status: 'resigned', winner: 'host' }),
      write('the host closes the match at 6 goals', 'DENY', 'host-uid', '/meta', { guest: 'guest-uid', status: 'over', winner: 'host' }),
      write('the guest marks itself present', 'ALLOW', 'guest-uid', '/presence/guest', true),
      write('the guest marks the host gone', 'DENY', 'guest-uid', '/presence/host', false),
      write('the host deletes the frame', 'DENY', 'host-uid', '/frame', null),
      write('a frame after the match ended', 'DENY', 'host-uid', '/frame', next, over),
    ];
    cases.push({
      description: 'the host opens a new match',
      expectation: 'ALLOW',
      operation: 'write',
      path: '/airhockey/m2/host-uid/meta',
      auth: 'host-uid',
      data: {},
      newData: { guest: 'guest-uid', status: 'playing', winner: '' },
    });
    cases.push({
      description: 'a stranger opens a match at the host path',
      expectation: 'DENY',
      operation: 'write',
      path: '/airhockey/m2/host-uid/meta',
      auth: 'stranger-uid',
      data: {},
      newData: { guest: 'guest-uid', status: 'playing', winner: '' },
    });
    const summary = airHockeyRtdbRules.simulate(cases);
    // A denial decided above a node with no rule of its own comes back
    // UNSUPPORTED instead of DENY (bugs/0018): the two writes to a puck coordinate.
    const noRule = (c: (typeof summary.cases)[number]) =>
      c.expectation === 'DENY' && c.decision === 'UNSUPPORTED' && /No 'write' rule found/.test(c.reason);
    expect(summary.cases.filter((c) => !c.passed && !noRule(c)).map((c) => `${c.description}: ${c.decision} (${c.reason})`)).toEqual([]);
    expect(summary.cases.filter(noRule).map((c) => c.description)).toEqual([
      'the host moves the puck without a new tick',
      'the host moves the puck off the table',
    ]);
  });
});
