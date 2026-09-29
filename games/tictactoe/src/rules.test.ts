import { describe, expect, test } from 'bun:test';
import { runHarness, type Cheat } from '@games/harness';
import { ticTacToe } from './logic.ts';

const rules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();

/** Cheats beyond the shared placement cheats. */
const cheats: Cheat[] = [
  {
    // The shared "keeps the turn" cheat leaves currentTurn unchanged; this one
    // changes it to a value that is neither seat.
    name: 'the turn passes to a non-seat value',
    forge: (_b, after) => ({ ...after, currentTurn: 'nobody' as never }),
  },
];

describe('tic-tac-toe Security Rules', () => {
  test('allow every real transition and deny every cheat across 60 random games', () => {
    const report = runHarness(ticTacToe, rules, { games: 60, seed: 1, cheats });
    const summary = report.failures.map((f) => `${f.decision} (expected ${f.expectation}): ${f.description}`);
    expect(summary).toEqual([]);
    expect(report.cases).toBeGreaterThan(1000);
  });
});
