import { describe, expect, test } from 'bun:test';
import { runHarness } from '@games/harness';
import { ticTacToe } from './logic.ts';

const rules = await Bun.file(new URL('../../../app/firestore.rules', import.meta.url)).text();

describe('tic-tac-toe Security Rules', () => {
  test('allow every real transition and deny every cheat across 60 random games', () => {
    const report = runHarness(ticTacToe, rules, { games: 60, seed: 1 });
    const summary = report.failures.map((f) => `${f.decision} (expected ${f.expectation}): ${f.description}`);
    expect(summary).toEqual([]);
    expect(report.cases).toBeGreaterThan(1000);
  });
});
