// Repro 0024: `pyric firestore rules validate` exits 0 when the rules parse but
// the validator reports a high-severity finding, such as a call to an undefined
// function (SEM-4). A parse error exits 2, so only these findings are missed.
//   bun bugs/repro/0024.ts      (exit 1 while the bug is present)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pyric = new URL('../../node_modules/.bin/pyric', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'repro-0024-'));
const file = join(dir, 'firestore.rules');
writeFileSync(file, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read: if notDefined(); }
  }
}
`);

const r = Bun.spawnSync([pyric, 'firestore', 'rules', 'validate', file], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
const findings = JSON.parse(r.stdout.toString()) as Array<{ code: string; severity: string }>;
const high = findings.filter((f) => f.severity === 'high').map((f) => f.code);
console.log(`firestore rules validate: exit ${r.exitCode}, high-severity findings: ${high.join(', ') || 'none'}`);
process.exit(high.length > 0 && r.exitCode === 0 ? 1 : 0);
