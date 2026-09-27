// Removal probe for Realtime Database rules written in TypeScript: replace one
// clause of the constraint source, regenerate app/database.rules.json, run a
// test, and report whether the test caught it. The source and the JSON are
// restored afterwards.
//   bun tools/removal-probe-rtdb.ts <rules.ts> '<exact text>' <test path> ['<replacement>']
// With PROBE_FAST set to a test name pattern, the tests it matches run first; the whole test
// runs only when they pass.
import { $ } from 'bun';

const [sourcePath, snippet, testPath, replacement = ''] = process.argv.slice(2);
const fast = process.env.PROBE_FAST ?? '';
if (!sourcePath || !snippet || !testPath) {
  throw new Error("usage: bun tools/removal-probe-rtdb.ts <rules.ts> '<text to remove>' <test path> ['<replacement>']");
}
const original = await Bun.file(sourcePath).text();
const first = original.indexOf(snippet);
if (first < 0) throw new Error(`Text not found in ${sourcePath}: ${snippet}`);
if (original.indexOf(snippet, first + 1) >= 0) throw new Error(`Text is not unique in ${sourcePath}: ${snippet}`);

async function fails(): Promise<boolean> {
  if (fast && (await $`bun test ${testPath} -t ${fast}`.nothrow().quiet()).exitCode !== 0) return true;
  return (await $`bun test ${testPath}`.nothrow().quiet()).exitCode !== 0;
}

try {
  await Bun.write(sourcePath, original.replace(snippet, replacement));
  const generated = await $`bun tools/rtdb-rules.ts`.nothrow().quiet();
  if (generated.exitCode !== 0) {
    console.log(`INVALID: removing "${snippet}" breaks the rules source: ${generated.stderr.toString().slice(0, 300)}`);
  } else {
    console.log((await fails()) ? `caught: removing "${snippet}" fails the test` : `NOT CAUGHT: removing "${snippet}" still passes`);
  }
} finally {
  await Bun.write(sourcePath, original);
  await $`bun tools/rtdb-rules.ts`.quiet();
}
