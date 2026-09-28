// Removal probe: delete one check from a rules file, re-resolve, run a test,
// and report whether the test caught it. The file is restored afterwards.
//   bun tools/removal-probe.ts <file.rules> '<exact text to remove>' <test path> ['<replacement>']
// The file is a rules module that `bun run rules:resolve` reads: a Firestore
// module (resolved into app/firestore.rules), app/storage.modules.rules
// (resolved into app/storage.rules), or a standard library module in the
// installed Pyric dist. A plain Storage rules file is parsed as is. A
// replacement keeps the source valid when the removed check ends a
// statement. A change that leaves the rules unparseable is reported INVALID,
// not caught, so a probe never counts a syntax error as a caught removal.
// With PROBE_FAST set to a test name pattern, the tests it matches run first; the whole test
// runs only when they pass, so a probe they catch costs only their time. A
// pattern that matches no test is an error, not a caught removal.
import { $ } from 'bun';
import { parseStorageRules } from 'pyric/storage';

const [modulePath, snippet, testPath, replacement = ''] = process.argv.slice(2);
const fast = process.env.PROBE_FAST ?? '';
if (!modulePath || !snippet || !testPath) {
  throw new Error("usage: bun tools/removal-probe.ts <file.rules> '<text to remove>' <test path> ['<replacement>']");
}
const original = await Bun.file(modulePath).text();
const first = original.indexOf(snippet);
if (first < 0) throw new Error(`Text not found in ${modulePath}: ${snippet}`);
if (original.indexOf(snippet, first + 1) >= 0) throw new Error(`Text is not unique in ${modulePath}: ${snippet}`);
const isPlainStorage = /service\s+firebase\.storage/.test(original) && !/rules_version\s*=\s*'2\+modules'/.test(original);

async function fails(): Promise<boolean> {
  if (fast) {
    const quick = await $`bun test ${testPath} -t ${fast}`.nothrow().quiet();
    if (/matched 0 tests/.test(`${quick.stdout}${quick.stderr}`)) {
      throw new Error(`PROBE_FAST pattern ${JSON.stringify(fast)} matches no test in ${testPath}`);
    }
    if (quick.exitCode !== 0) return true;
  }
  return (await $`bun test ${testPath}`.nothrow().quiet()).exitCode !== 0;
}

/** Why the changed source can't be used, or '' when it parses and resolves. */
async function invalid(changed: string): Promise<string> {
  if (isPlainStorage) {
    try {
      parseStorageRules(changed);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  const resolved = await $`bun run rules:resolve`.nothrow().quiet();
  return resolved.exitCode === 0 ? '' : resolved.stderr.toString().slice(0, 300);
}

try {
  const changed = original.replace(snippet, replacement);
  await Bun.write(modulePath, changed);
  const problem = await invalid(changed);
  if (problem) console.log(`INVALID: removing "${snippet}" breaks the rules: ${problem}`);
  else console.log((await fails()) ? `caught: removing "${snippet}" fails the test` : `NOT CAUGHT: removing "${snippet}" still passes`);
} finally {
  await Bun.write(modulePath, original);
  await $`bun run rules:resolve`.quiet();
}
