// A TINY RASTERIZER + PNG ENCODER, no dependencies: enough to draw a trade replay (candles, fills, levels,
// a few labels) into a PNG that Slack can show inline. Node's zlib does the compression.
import { deflateSync } from "node:zlib";

export type RGBA = [number, number, number, number];

export class Raster {
  readonly w: number; readonly h: number; readonly px: Uint8ClampedArray;
  constructor(w: number, h: number, bg: RGBA) {
    this.w = w; this.h = h; this.px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { this.px[i * 4] = bg[0]; this.px[i * 4 + 1] = bg[1]; this.px[i * 4 + 2] = bg[2]; this.px[i * 4 + 3] = bg[3]; }
  }
  set(x: number, y: number, c: RGBA) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, a = c[3] / 255;
    this.px[i] = this.px[i] * (1 - a) + c[0] * a; this.px[i + 1] = this.px[i + 1] * (1 - a) + c[1] * a; this.px[i + 2] = this.px[i + 2] * (1 - a) + c[2] * a; this.px[i + 3] = 255;
  }
  rect(x: number, y: number, w: number, h: number, c: RGBA) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  line(x0: number, y0: number, x1: number, y1: number, c: RGBA, dash = 0) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, n = 0;
    for (;;) {
      if (!dash || Math.floor(n / dash) % 2 === 0) this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
      n++;
    }
  }
  triangle(x: number, y: number, size: number, up: boolean, c: RGBA) {
    for (let j = 0; j <= size; j++) { const half = up ? j : size - j; for (let i = -half; i <= half; i++) this.set(x + i, up ? y - size + j : y + j, c); }
  }
  text(x: number, y: number, s: string, c: RGBA, scale = 1) {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT["?"];
      for (let r = 0; r < 5; r++) for (let col = 0; col < 3; col++) if (g[r][col] === "#") this.rect(cx + col * scale, y + r * scale, scale, scale, c);
      cx += 4 * scale;
    }
  }
  textWidth(s: string, scale = 1) { return s.length * 4 * scale; }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) { raw[y * (this.w * 4 + 1)] = 0; Buffer.from(this.px.buffer, y * this.w * 4, this.w * 4).copy(raw, y * (this.w * 4 + 1) + 1); }
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  }
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) { CRC_TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A 3x5 pixel font: digits, letters, and the few symbols a price label needs.
const FONT: Record<string, string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"], "1": [".#.", "##.", ".#.", ".#.", "###"], "2": ["###", "..#", "###", "#..", "###"], "3": ["###", "..#", "###", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"], "5": ["###", "#..", "###", "..#", "###"], "6": ["###", "#..", "###", "#.#", "###"], "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"], "9": ["###", "#.#", "###", "..#", "###"], ".": ["...", "...", "...", "...", ".#."], "-": ["...", "...", "###", "...", "..."],
  "+": ["...", ".#.", "###", ".#.", "..."], "/": ["..#", "..#", ".#.", "#..", "#.."], ":": ["...", ".#.", "...", ".#.", "..."], "@": ["###", "#.#", "###", "#..", "###"],
  " ": ["...", "...", "...", "...", "..."], "?": ["###", "..#", ".##", "...", ".#."], "$": [".##", "#..", "###", "..#", "##."], "X": ["#.#", "#.#", ".#.", "#.#", "#.#"],
  "A": [".#.", "#.#", "###", "#.#", "#.#"], "B": ["##.", "#.#", "##.", "#.#", "##."], "C": ["###", "#..", "#..", "#..", "###"], "D": ["##.", "#.#", "#.#", "#.#", "##."],
  "E": ["###", "#..", "##.", "#..", "###"], "F": ["###", "#..", "##.", "#..", "#.."], "G": ["###", "#..", "#.#", "#.#", "###"], "H": ["#.#", "#.#", "###", "#.#", "#.#"],
  "I": ["###", ".#.", ".#.", ".#.", "###"], "J": ["..#", "..#", "..#", "#.#", "###"], "K": ["#.#", "#.#", "##.", "#.#", "#.#"], "L": ["#..", "#..", "#..", "#..", "###"],
  "M": ["#.#", "###", "###", "#.#", "#.#"], "N": ["##.", "#.#", "#.#", "#.#", "#.#"], "O": ["###", "#.#", "#.#", "#.#", "###"], "P": ["###", "#.#", "###", "#..", "#.."],
  "Q": ["###", "#.#", "#.#", "###", "..#"], "R": ["##.", "#.#", "##.", "#.#", "#.#"], "S": ["###", "#..", "###", "..#", "###"], "T": ["###", ".#.", ".#.", ".#.", ".#."],
  "U": ["#.#", "#.#", "#.#", "#.#", "###"], "V": ["#.#", "#.#", "#.#", "#.#", ".#."], "W": ["#.#", "#.#", "###", "###", "#.#"], "Y": ["#.#", "#.#", ".#.", ".#.", ".#."],
  "Z": ["###", "..#", ".#.", "#..", "###"],
};

// ---- GIF89a, animated, with a fixed palette — the "video" of a trade for Slack ----
export function encodeGif(w: number, h: number, frames: { indices: Uint8Array; delayCs: number }[], palette: RGBA[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from("GIF89a", "ascii"));
  const lsd = Buffer.alloc(7); lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2); lsd[4] = 0xf7; lsd[5] = 0; lsd[6] = 0;   // global color table, 256 entries
  parts.push(lsd);
  const pal = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) { const c = palette[i] ?? palette[0]; pal[i * 3] = c[0]; pal[i * 3 + 1] = c[1]; pal[i * 3 + 2] = c[2]; }
  parts.push(pal);
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "ascii"), 0x03, 0x01, 0x00, 0x00, 0x00]));   // loop forever
  for (const f of frames) {
    const gce = Buffer.alloc(8); gce[0] = 0x21; gce[1] = 0xf9; gce[2] = 4; gce[3] = 0; gce.writeUInt16LE(f.delayCs, 4); gce[6] = 0; gce[7] = 0;
    parts.push(gce);
    const desc = Buffer.alloc(10); desc[0] = 0x2c; desc.writeUInt16LE(0, 1); desc.writeUInt16LE(0, 3); desc.writeUInt16LE(w, 5); desc.writeUInt16LE(h, 7); desc[9] = 0;
    parts.push(desc);
    parts.push(Buffer.from([8]));
    parts.push(lzw(f.indices, 8));
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/** LZW as GIF wants it: variable code width, clear at 4096, output cut into ≤255-byte sub-blocks. */
function lzw(px: Uint8Array, minCode: number): Buffer {
  const CLEAR = 1 << minCode, EOI = CLEAR + 1;
  let dict = new Map<number, number>(), next = EOI + 1, width = minCode + 1;
  const out: number[] = []; let acc = 0, nbits = 0;
  const emit = (code: number) => { acc |= code << nbits; nbits += width; while (nbits >= 8) { out.push(acc & 0xff); acc >>>= 8; nbits -= 8; } };
  emit(CLEAR);
  let prefix = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i], key = (prefix << 8) | k, found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next - 1 === 1 << width && width < 12) width++; }
    else { emit(CLEAR); dict = new Map(); next = EOI + 1; width = minCode + 1; }
    prefix = k;
  }
  emit(prefix); emit(EOI);
  if (nbits > 0) out.push(acc & 0xff);
  const blocks: Buffer[] = [];
  for (let i = 0; i < out.length; i += 255) { const slice = out.slice(i, i + 255); blocks.push(Buffer.from([slice.length, ...slice])); }
  return Buffer.concat(blocks);
}

/** Map every pixel of a raster to the nearest palette entry (exact for the solid colors the GIF frames use). */
export function indexRaster(r: Raster, palette: RGBA[]): Uint8Array {
  const out = new Uint8Array(r.w * r.h);
  const cache = new Map<number, number>();
  for (let i = 0; i < r.w * r.h; i++) {
    const key = (r.px[i * 4] << 16) | (r.px[i * 4 + 1] << 8) | r.px[i * 4 + 2];
    let idx = cache.get(key);
    if (idx === undefined) {
      let best = 0, bd = Infinity;
      for (let p = 0; p < palette.length; p++) { const c = palette[p]; const d = (c[0] - r.px[i * 4]) ** 2 + (c[1] - r.px[i * 4 + 1]) ** 2 + (c[2] - r.px[i * 4 + 2]) ** 2; if (d < bd) { bd = d; best = p; } }
      idx = best; cache.set(key, idx);
    }
    out[i] = idx;
  }
  return out;
}
