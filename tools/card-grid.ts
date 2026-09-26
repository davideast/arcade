// Print each card cell of a card sheet: its main fill color, and the glyph in the
// card's center as ASCII, so values and colors can be mapped to frame positions.
//   bun tools/card-grid.ts <sheet.png> <x0> <y0> <cols> <rows> <w> <h>
import { decodePng } from './sprite-regions.ts';

const [path, ...nums] = process.argv.slice(2);
const [x0, y0, cols, rows, w, h] = nums.map(Number);
const img = await decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
const px = (x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return img.rgba[i + 3] === 0 ? 'none' : `#${[0, 1, 2].map((k) => img.rgba[i + k].toString(16).padStart(2, '0')).join('')}`;
};
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const cx = x0 + c * w;
    const cy = y0 + r * h;
    const counts = new Map<string, number>();
    for (let y = cy + 2; y < cy + h - 2; y++) for (let x = cx + 2; x < cx + w - 2; x++) counts.set(px(x, y), (counts.get(px(x, y)) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const fill = ranked[0][0];
    const glyphColor = ranked[1]?.[0];
    const lines: string[] = [];
    for (let y = cy + 7; y < cy + 17; y++) {
      let line = '';
      for (let x = cx + 3; x < cx + 13; x++) line += px(x, y) === glyphColor ? '#' : px(x, y) === fill ? '.' : ' ';
      lines.push(line);
    }
    console.log(`card col=${c} row=${r} x=${cx} y=${cy} fill=${fill} glyph=${glyphColor}`);
    console.log(lines.join('\n'));
  }
}
