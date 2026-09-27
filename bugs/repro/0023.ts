// Repro 0023: `pyric rules lint --service database` and `pyric rules simulate
// --service database` read a rules file with plain JSON.parse, so a
// database.rules.json with a comment is rejected as "not valid JSON", while
// `pyric database rules validate` strips comments and accepts the same file.
//   bun bugs/repro/0023.ts      (exit 1 while the bug is present)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pyric = new URL('../../node_modules/.bin/pyric', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'repro-0023-'));
const file = join(dir, 'database.rules.json');
writeFileSync(file, `{
  // Each user reads and writes their own notes.
  "rules": {
    "notes": { "$uid": { ".read": "auth != null && auth.uid == $uid", ".write": "auth != null && auth.uid == $uid" } }
  }
}
`);

function run(args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([pyric, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.split('\n').filter((l) => /not valid JSON|"errors"|issues|findings/.test(l)).join(' ').trim();
  return { code: r.exitCode ?? -1, out };
}

const validate = run(['database', 'rules', 'validate', file]);
const lint = run(['rules', 'lint', '--service', 'database', '--rules-file', file]);
console.log(`database rules validate: exit ${validate.code} ${validate.out}`);
console.log(`rules lint --service database: exit ${lint.code} ${lint.out}`);
process.exit(validate.code === 0 && lint.code === 0 ? 0 : 1);
