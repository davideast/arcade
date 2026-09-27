// Write app/database.rules.json from the Realtime Database rules written in
// TypeScript, or check that the file is current.
//   bun tools/rtdb-rules.ts           write the file
//   bun tools/rtdb-rules.ts --check   exit 1 when the file differs from the source
import { airHockeyRtdbRules } from '../games/air-hockey/src/rtdb-rules.ts';

export const RULES_PATH = new URL('../app/database.rules.json', import.meta.url);

export function renderRules(): string {
  return `${JSON.stringify(airHockeyRtdbRules.toJSON(), null, 2)}\n`;
}

if (import.meta.main) {
  const rendered = renderRules();
  if (process.argv.includes('--check')) {
    const file = Bun.file(RULES_PATH);
    const current = (await file.exists()) ? await file.text() : '';
    if (current !== rendered) {
      console.log('app/database.rules.json is out of date: run bun tools/rtdb-rules.ts');
      process.exit(1);
    }
    console.log('app/database.rules.json matches the TypeScript source');
  } else {
    await Bun.write(RULES_PATH, rendered);
    console.log('wrote app/database.rules.json');
  }
}
