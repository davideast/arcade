// Repro 0039: the source map of a resolved ruleset names 'firestore.rules'
// as the authored file of the root file's `service` line and of the `let`
// bindings in the root file's functions, in place of the root file's name.
// Module lines name their module. A Storage ruleset gets 'firestore.rules'
// too. Exit 1 while any root line names a file other than the root file.
//   bun bugs/repro/0039.ts
import { resolveModules } from 'pyric/rules/internal/node';

const sources: Record<string, string> = {
  'firestore.modules.rules': `rules_version = '2+modules';
import { check } from './m';
service cloud.firestore {
  match /databases/{database}/documents {
    function own() {
      let uid = request.auth.uid;
      return uid == resource.data.owner;
    }
    match /games/{id} { allow update: if own() && check(); }
  }
}`,
  'storage.modules.rules': `rules_version = '2+modules';
import { check } from './m';
service firebase.storage {
  match /b/{bucket}/o {
    function own() {
      let uid = request.auth.uid;
      return uid == resource.metadata.owner;
    }
    match /games/{id} { allow write: if own() && check(); }
  }
}`,
};
const module = 'export function check() { return request.auth != null; }';

let failed = false;
for (const [file, source] of Object.entries(sources)) {
  const r = resolveModules(source, { sourceFile: file, modules: { './m': module } });
  if (!r.success) {
    console.log(`${file}: does not resolve: ${r.error.message}`);
    failed = true;
    continue;
  }
  const output = r.data.resolved;
  const marker = '// @pyric-source-map: ';
  const map = JSON.parse(output.slice(output.indexOf(marker) + marker.length).split('\n')[0]) as Array<{
    generatedLine: number; authoredLine: number; authoredFile: string;
  }>;
  const lines = output.split('\n');
  for (const entry of map) {
    if (entry.authoredFile === './m' || entry.authoredFile === 'm') continue;
    const text = lines[entry.generatedLine - 1].trim();
    const ok = entry.authoredFile === file;
    failed ||= !ok;
    console.log(`${file}: generated line ${entry.generatedLine} "${text.slice(0, 40)}" -> ${entry.authoredFile}:${entry.authoredLine}${ok ? '' : ' (expected ' + file + ')'}`);
  }
}
process.exit(failed ? 1 : 0);
