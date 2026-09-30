// A real, minimal PNG encoder for tests (8-bit RGB, filter 0, one IDAT) — so image tests exercise
// genuine files `sips` can read, at any size, without committing binary fixtures.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A `width`×`height` RGB PNG. `noise` fills it with pseudo-random pixels (barely compressible, so the
 *  file is large); otherwise a smooth gradient (compresses well). */
export function makePng(width: number, height: number, opts: { noise?: boolean } = {}): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  let seed = 0x2545f491;
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      if (opts.noise) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        raw[i] = seed & 0xff; raw[i + 1] = (seed >>> 8) & 0xff; raw[i + 2] = (seed >>> 16) & 0xff;
      } else {
        raw[i] = (x * 255 / width) | 0; raw[i + 1] = (y * 255 / height) | 0; raw[i + 2] = 128;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width); v.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 1 }))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
