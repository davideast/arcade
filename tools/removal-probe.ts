// Removal probe: delete one check from a rules module, re-resolve, run a test,
// and report whether the test caught it. The module is restored afterwards.
//   bun tools/removal-probe.ts <module.rules> '<exact text to remove>' <test path> ['<replacement>'] ['<fast pattern>']
// A replacement keeps the source valid when the removed check ends a statement.
// With a fast pattern, the tests whose names match it run first; the whole test
// runs only when they pass, so a probe they catch costs only their time.
import { $ } from 'bun';

const [modulePath, snippet, testPath, replacement = '', fast = ''] = process.argv.slice(2);
if (!modulePath || !snippet || !testPath) {
  throw new Error("usage: bun tools/removal-probe.ts <module.rules> '<text to remove>' <test path> ['<replacement>'] ['<fast pattern>']");
}
const original = await Bun.file(modulePath).text();
if (!original.includes(snippet)) throw new Error(`Text not found in ${modulePath}: ${snippet}`);

async function fails(): Promise<boolean> {
  if (fast && (await $`bun test ${testPath} -t ${fast}`.nothrow().quiet()).exitCode !== 0) return true;
  return (await $`bun test ${testPath}`.nothrow().quiet()).exitCode !== 0;
}

try {
  await Bun.write(modulePath, original.replace(snippet, replacement));
  await $`bun run rules:resolve`.quiet();
  console.log((await fails()) ? `caught: removing "${snippet}" fails the test` : `NOT CAUGHT: removing "${snippet}" still passes`);
} finally {
  await Bun.write(modulePath, original);
  await $`bun run rules:resolve`.quiet();
}
