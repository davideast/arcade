/**
 * Find the sprites on a sheet: decode an RGBA8 PNG with web-standard APIs
 * (DecompressionStream, DataView), then report each connected opaque region's
 * bounding box. Runs in Bun or a browser.
 *
 *   bun sprite-regions.ts <sheet.png> [x0 y0 x1 y1]
 */

export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export async function decodePng(bytes: Uint8Array): Promise<Image> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => bytes[i] === b)) throw new Error('Not a PNG file');

  let width = 0;
  let height = 0;
  const chunks: Uint8Array[] = [];
  for (let pos = 8; pos < bytes.length; ) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const [depth, colorType, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`Only 8-bit RGBA non-interlaced PNGs are supported (depth ${depth}, color type ${colorType})`);
      }
    } else if (type === 'IDAT') {
      chunks.push(body);
    }
    pos += 12 + length;
  }

  const compressed = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    compressed.set(c, offset);
    offset += c.length;
  }
  const raw = await inflate(compressed);

  const bpp = 4;
  const stride = width * bpp;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rgba[dst + x - bpp] : 0;
      const b = y > 0 ? rgba[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? rgba[dst - stride + x - bpp] : 0;
      const v = raw[src + x];
      let out: number;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: out = v + paeth(a, b, c); break;
        default: throw new Error(`Unknown PNG filter ${filter} on row ${y}`);
      }
      rgba[dst + x] = out & 0xff;
    }
  }
  return { width, height, rgba };
}

/** Bounding boxes of 8-connected opaque regions inside a window of the image. */
export function findRegions(
  img: Image,
  x0 = 0,
  y0 = 0,
  x1 = img.width,
  y1 = img.height,
): Region[] {
  const opaque = (x: number, y: number) => img.rgba[(y * img.width + x) * 4 + 3] !== 0;
  const seen = new Uint8Array(img.width * img.height);
  const regions: Region[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (seen[y * img.width + x] || !opaque(x, y)) continue;
      let minX = x, minY = y, maxX = x, maxY = y;
      const stack: Array<[number, number]> = [[x, y]];
      seen[y * img.width + x] = 1;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            const inWindow = nx >= x0 && nx < x1 && ny >= y0 && ny < y1;
            if (!inWindow || seen[ny * img.width + nx] || !opaque(nx, ny)) continue;
            seen[ny * img.width + nx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      regions.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
  }
  return regions;
}

if (import.meta.main) {
  const [path, ...window] = process.argv.slice(2);
  if (!path) throw new Error('usage: bun sprite-regions.ts <sheet.png> [x0 y0 x1 y1]');
  const img = await decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const [x0, y0, x1, y1] = window.map(Number);
  console.log(`size ${img.width}x${img.height}`);
  for (const r of findRegions(img, x0 || 0, y0 || 0, x1 || img.width, y1 || img.height)) {
    console.log(`region x=${r.x} y=${r.y} w=${r.w} h=${r.h}`);
  }
}
