// Crop a region of a sheet and write it scaled up with nearest-neighbor pixels,
// for looking at small sprites. Web APIs only (CompressionStream for the PNG).
//   bun tools/upscale.ts <sheet.png> <x> <y> <w> <h> <scale> <out.png>
import { decodePng } from './sprite-regions.ts';

const [path, ...rest] = process.argv.slice(2);
const out = rest.pop()!;
const [x0, y0, w, h, scale] = rest.map(Number);
const img = await decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));

const W = w * scale;
const H = h * scale;
const raw = new Uint8Array((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    const si = ((y0 + Math.floor(y / scale)) * img.width + (x0 + Math.floor(x / scale))) * 4;
    const di = y * (W * 4 + 1) + 1 + x * 4;
    raw.set(img.rgba.subarray(si, si + 4), di);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};
const ihdr = new Uint8Array(13);
new DataView(ihdr.buffer).setUint32(0, W);
new DataView(ihdr.buffer).setUint32(4, H);
ihdr.set([8, 6, 0, 0, 0], 8);
const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
const idat = new Uint8Array(await new Response(stream).arrayBuffer());
const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())];
await Bun.write(out, new Blob(parts));
console.log(`wrote ${out} (${W}x${H})`);
