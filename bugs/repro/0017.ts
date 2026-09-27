// Repro 0017: `simulate` on a handle made from a TypeScript definition
// (`rtdbRules(defineRtdbRules(...))`) compiles the whole definition again for
// every case, so each case costs a full compile; the same rules as compiled
// JSON (`rtdbRules(handle.toJSON())`) simulate the same cases many times
// faster. Exit 1 while a definition case costs more than 3 times a JSON case.
//   bun bugs/repro/0017.ts
import { all, authenticated, defineRtdbRules, expr, rtdbRules, type PathDef } from 'pyric/rules';

// Forty paths, each with a ten-term write rule.
const paths: Record<string, PathDef> = {};
for (let p = 0; p < 40; p++) {
  paths[`/area${p}/$id`] = { write: all(authenticated(), ...Array.from({ length: 9 }, (_, k) => expr(`newData.child('f${k}').val() != ${k}`))) };
}
const fromDefinition = rtdbRules(defineRtdbRules({ paths }));
const fromJson = rtdbRules(fromDefinition.toJSON());
const cases = Array.from({ length: 40 }, (_, i) => ({
  expectation: 'ALLOW' as const,
  operation: 'write' as const,
  path: `/area${i}/x`,
  auth: 'u',
  newData: { f0: 100 },
}));

function perCase(handle: typeof fromJson): number {
  handle.simulate(cases.slice(0, 2));
  const t = performance.now();
  const summary = handle.simulate(cases);
  if (summary.passed !== cases.length) throw new Error(`expected every case to pass, got ${summary.passed}`);
  return (performance.now() - t) / cases.length;
}

const definitionCost = perCase(fromDefinition);
const jsonCost = perCase(fromJson);
console.log(`definition handle: ${definitionCost.toFixed(2)} ms per case`);
console.log(`JSON handle: ${jsonCost.toFixed(2)} ms per case`);
process.exit(definitionCost > jsonCost * 3 ? 1 : 0);
