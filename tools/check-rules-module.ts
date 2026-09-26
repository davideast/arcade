// Report why a rules module fails to parse: tries the module with each
// top-level declaration removed in turn.
//   bun tools/check-rules-module.ts <module.rules>
import { parseFunctions } from 'pyric/rules/internal';

const path = process.argv[2];
if (!path) throw new Error('usage: bun tools/check-rules-module.ts <module.rules>');
const source = await Bun.file(path).text();
console.log('whole module parses:', parseFunctions(source, 'module') !== null);

const withoutImports = source.replace(/^import[\s\S]*?;\s*$/gm, '');
console.log('without import lines:', parseFunctions(withoutImports, 'module') !== null);

const blocks = withoutImports.split(/\n(?=(?:export )?function )/);
for (let i = 0; i < blocks.length; i++) {
  const single = blocks[i];
  if (!/function /.test(single)) continue;
  const name = single.match(/function (\w+)/)?.[1];
  console.log(`${name}: ${parseFunctions(single, 'module') !== null ? 'parses' : 'FAILS'}`);
}
