// Print a window of a sheet as a character grid, one character per color.
//   bun dump-pixels.ts <sheet.png> x0 y0 x1 y1 [step]
import { decodePng } from './sprite-regions.ts';

const [path, ...nums] = process.argv.slice(2);
const [x0, y0, x1, y1, step = 1] = nums.map(Number);
const img = await decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
const legend = new Map<string, string>();
const chars = '.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
for (let y = y0; y < y1; y += step) {
  let line = '';
  for (let x = x0; x < x1; x += step) {
    const i = (y * img.width + x) * 4;
    const [r, g, b, a] = img.rgba.subarray(i, i + 4);
    const key = a === 0 ? 'transparent' : `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    if (!legend.has(key)) legend.set(key, key === 'transparent' ? ' ' : chars[legend.size]);
    line += legend.get(key);
  }
  console.log(`${String(y).padStart(3)} ${line}`);
}
for (const [color, ch] of legend) console.log(`${JSON.stringify(ch)} ${color}`);
