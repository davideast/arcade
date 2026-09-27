// Repro 0015: checks on a Realtime Database rules JSON file can't fail. For a
// rule that doesn't parse, `rtdbRules(json).lint()` and `pyric rules lint
// --service database` report nothing, and `pyric database rules validate`
// prints the PARSE_ERROR but exits 0. The same rule in a TypeScript
// definition lints as an error.
//   bun bugs/repro/0015.ts      (exit 1 while the bug is present)
import { $ } from 'bun';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rtdbRules } from 'pyric/rules';

const broken = 'auth != null && (';
const json = { rules: { notes: { $id: { '.write': broken } } } };
const file = join(tmpdir(), `pyric-repro-0015-${process.pid}.json`);
await Bun.write(file, JSON.stringify(json, null, 2));

const fromDefinition = rtdbRules({ paths: { '/notes/$id': { write: broken } } }).lint();
const fromJson = rtdbRules(json).lint();
const validate = await $`bunx pyric database rules validate ${file}`.nothrow().quiet();
const cliLint = await $`bunx pyric rules lint --service database --rules-file ${file}`.nothrow().quiet();
const cliIssues = JSON.parse(/\{[\s\S]*\}/.exec(cliLint.stdout.toString())?.[0] ?? '{"issues":[]}').issues as unknown[];

console.log(`rtdbRules(definition).lint(): ${fromDefinition.map((i) => `${i.severity} ${i.code}`).join(', ') || 'no issues'}`);
console.log(`rtdbRules(json).lint(): ${fromJson.map((i) => `${i.severity} ${i.code}`).join(', ') || 'no issues'}`);
console.log(`pyric database rules validate: exit ${validate.exitCode}, ${validate.stdout.toString().includes('PARSE_ERROR') ? 'reports PARSE_ERROR' : 'no PARSE_ERROR'}`);
console.log(`pyric rules lint --service database: exit ${cliLint.exitCode}, ${cliIssues.length} issues`);
const ok = fromJson.some((i) => i.severity === 'error') && validate.exitCode !== 0 && cliIssues.length > 0;
process.exit(ok ? 0 : 1);
