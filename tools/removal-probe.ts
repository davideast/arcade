// Removal probe: delete one check from a rules module, re-resolve, run a test,
// and report whether the test caught it. The module is restored afterwards.
//   bun tools/removal-probe.ts <module.rules> '<exact text to remove>' <test path>
import { $ } from 'bun';

const [modulePath, snippet, testPath] = process.argv.slice(2);
if (!modulePath || !snippet || !testPath) {
  throw new Error("usage: bun tools/removal-probe.ts <module.rules> '<text to remove>' <test path>");
}
const original = await Bun.file(modulePath).text();
if (!original.includes(snippet)) throw new Error(`Text not found in ${modulePath}: ${snippet}`);

try {
  await Bun.write(modulePath, original.replace(snippet, ''));
  await $`bun run rules:resolve`.quiet();
  const result = await $`bun test ${testPath}`.nothrow().quiet();
  console.log(result.exitCode === 0 ? `NOT CAUGHT: removing "${snippet}" still passes` : `caught: removing "${snippet}" fails the test`);
} finally {
  await Bun.write(modulePath, original);
  await $`bun run rules:resolve`.quiet();
}
