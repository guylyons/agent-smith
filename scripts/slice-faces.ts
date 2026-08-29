// One-shot asset build: turn the raw Agent Smith face sheet into the normalized
// sprite sheet the HUD renders from.
//
//   bun run scripts/slice-faces.ts
//
// The source sheet (assets/agent-smith-faces.png) is a scan-style grid — the
// faces sit on white at slightly different sizes and offsets, so a plain
// background-position crop would make the head jitter as frames change. This
// script finds each face's true bounding box, downsamples every one by the SAME
// global factor (so a profile view stays visibly wider than a head-on one,
// exactly as on the source sheet), and lays them out on an even grid.
//
// Output is committed, so the app never depends on this running. Re-run it only
// when the source sheet changes.
// node:zlib rather than Bun's: these are the zlib-wrapped variants PNG needs
// (Bun's same-named helpers operate on raw deflate streams).
import { inflateSync, deflateSync } from "node:zlib";

const SRC = "assets/agent-smith-faces.png";
const OUT = "src/ui/faces.png";

// Grid cell in the output sheet, sized so the widest face on the source (a
// profile view, 170px) still fits once its row's scale is applied. The HUD draws
// these at exactly 2x, so keeping the native cell small both halves the asset
// and lands on whole pixels. For reference DOOM's own status face is 24x29 —
// this is already the more detailed sprite.
const CELL_W = 42;
const CELL_H = 48;
const COLS = 7;
const ROWS = 6;
const EXPECTED_FACES = 37;

type Image = { w: number; h: number; rgb: Uint8Array }; // 3 bytes per pixel

// ---- PNG decode (8-bit RGB, non-interlaced — all the source needs) --------

function decodePng(bytes: Uint8Array): Image {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  const depth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  if (depth !== 8 || colorType !== 2 || interlace !== 0) {
    throw new Error(`unsupported PNG: depth=${depth} colorType=${colorType} interlace=${interlace}`);
  }

  // Concatenate every IDAT before inflating — encoders split them freely.
  const idat: Uint8Array[] = [];
  for (let i = 8; i < bytes.length; ) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    if (type === "IDAT") idat.push(bytes.subarray(i + 8, i + 8 + len));
    if (type === "IEND") break;
    i += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of idat) { joined.set(c, at); at += c.length; }
  const raw = new Uint8Array(inflateSync(joined));

  // Undo per-scanline filtering (PNG spec 9.2). `bpp` is 3 for RGB8.
  const bpp = 3;
  const stride = w * bpp;
  const rgb = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rgb[dst + x - bpp]! : 0;
      const b = y > 0 ? rgb[up + x]! : 0;
      const c = x >= bpp && y > 0 ? rgb[up + x - bpp]! : 0;
      const v = raw[src + x]!;
      let out: number;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter} on row ${y}`);
      }
      rgb[dst + x] = out & 0xff;
    }
  }
  return { w, h, rgb };
}

// ---- PNG encode (8-bit RGBA, filter 0) -----------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode RGBA (4 bytes/px) as a PNG. Transparency matters here: the HUD sits
 *  on the app's dark chrome, so the sheet's white background must be dropped. */
function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const stride = w * 4;
  const bpp = 4;
  const raw = new Uint8Array(h * (stride + 1));
  // Paeth-filter every scanline. On photographic content that is worth several
  // times over storing the rows unfiltered, and decode cost is irrelevant for an
  // asset this small.
  for (let y = 0; y < h; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rgba[y * stride + x - bpp]! : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? rgba[(y - 1) * stride + x - bpp]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[dst + 1 + x] = (rgba[y * stride + x]! - pred) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---- Finding the faces ---------------------------------------------------

type Box = { x: number; y: number; w: number; h: number };

/** Near-white is background. The sheet is a clean white plate, so a high cutoff
 *  keeps the sprites' light highlights (shirt collars) as ink. */
function isInk(img: Image, x: number, y: number): boolean {
  const p = (y * img.w + x) * 3;
  return !(img.rgb[p]! > 240 && img.rgb[p + 1]! > 240 && img.rgb[p + 2]! > 240);
}

/** Contiguous true-runs longer than `min`, as [start, end] pairs. Short runs are
 *  dropped so a stray speck can't split a band or invent a cell. */
function runs(flags: boolean[], min = 4): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && start === null) start = i;
    else if (!flags[i] && start !== null) {
      if (i - start > min) out.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null && flags.length - start > min) out.push([start, flags.length - 1]);
  return out;
}

/** Every face on the sheet, in reading order: split into horizontal bands, then
 *  split each band into columns, then tighten each cell vertically. */
function findFaces(img: Image): Box[][] {
  const rowHasInk: boolean[] = [];
  for (let y = 0; y < img.h; y++) {
    let ink = false;
    for (let x = 0; x < img.w && !ink; x += 2) ink = isInk(img, x, y);
    rowHasInk.push(ink);
  }

  const grid: Box[][] = [];
  for (const [y0, y1] of runs(rowHasInk)) {
    const colHasInk: boolean[] = [];
    for (let x = 0; x < img.w; x++) {
      let ink = false;
      for (let y = y0; y <= y1 && !ink; y += 2) ink = isInk(img, x, y);
      colHasInk.push(ink);
    }
    const band: Box[] = [];
    for (const [x0, x1] of runs(colHasInk)) {
      let top = y1, bottom = y0;
      for (let y = y0; y <= y1; y++) {
        let ink = false;
        for (let x = x0; x <= x1 && !ink; x += 2) ink = isInk(img, x, y);
        if (ink) { if (y < top) top = y; if (y > bottom) bottom = y; }
      }
      band.push({ x: x0, y: top, w: x1 - x0 + 1, h: bottom - top + 1 });
    }
    grid.push(band);
  }
  return grid;
}

// ---- Compositing ---------------------------------------------------------

/** Box-filter one face into the destination cell at `scale`, writing RGBA and
 *  turning the sheet's white plate into transparency. Averaging over the whole
 *  source footprint (rather than sampling one pixel) is what keeps the shrunken
 *  faces readable instead of aliased into noise. */
function drawFace(src: Image, box: Box, out: Uint8Array, outW: number, dx: number, dy: number, scale: number) {
  const dw = Math.max(1, Math.round(box.w * scale));
  const dh = Math.max(1, Math.round(box.h * scale));
  for (let y = 0; y < dh; y++) {
    const sy0 = box.y + Math.floor((y * box.h) / dh);
    const sy1 = box.y + Math.max(sy0 + 1 - box.y, Math.floor(((y + 1) * box.h) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = box.x + Math.floor((x * box.w) / dw);
      const sx1 = box.x + Math.max(sx0 + 1 - box.x, Math.floor(((x + 1) * box.w) / dw));
      let r = 0, g = 0, b = 0, opaque = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const p = (sy * src.w + sx) * 3;
          r += src.rgb[p]!; g += src.rgb[p + 1]!; b += src.rgb[p + 2]!;
          if (isInk(src, sx, sy)) opaque++;
          n++;
        }
      }
      if (n === 0) continue;
      const d = ((dy + y) * outW + (dx + x)) * 4;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
      // Coverage-based alpha: a cell straddling the sprite edge fades out
      // instead of leaving a hard white fringe against the dark HUD.
      out[d + 3] = Math.round((opaque / n) * 255);
    }
  }
}

// ---- Main ----------------------------------------------------------------

const img = decodePng(new Uint8Array(await Bun.file(SRC).arrayBuffer()));
const grid = findFaces(img);
const faces = grid.flat();

if (faces.length !== EXPECTED_FACES) {
  throw new Error(`expected ${EXPECTED_FACES} faces, found ${faces.length} — the source sheet changed`);
}
for (const [i, band] of grid.entries()) {
  if (band.length > COLS) throw new Error(`row ${i} has ${band.length} faces, more than ${COLS} columns`);
}
if (grid.length > ROWS) throw new Error(`sheet has ${grid.length} rows, more than ${ROWS}`);

// Scale per source row, not globally. Each row of the sheet is drawn at its own
// consistent size — the last row's two special frames are cropped tighter and
// drawn smaller — so a single global factor would render those heads at
// obviously the wrong size when they swapped in. Sharing the factor *within* a
// row is what keeps a profile view legibly wider than a head-on one.
const rowScale = grid.map((band) => Math.min(
  CELL_W / Math.max(...band.map((f) => f.w)),
  CELL_H / Math.max(...band.map((f) => f.h)),
));

const outW = COLS * CELL_W;
const outH = ROWS * CELL_H;
const rgba = new Uint8Array(outW * outH * 4); // zero = fully transparent

for (const [row, band] of grid.entries()) {
  const scale = rowScale[row]!;
  for (const [col, box] of band.entries()) {
    const dw = Math.round(box.w * scale);
    const dh = Math.round(box.h * scale);
    // Centred horizontally, bottom-aligned: every face is a bust, so pinning the
    // shoulders to the cell floor keeps the eyeline steady as frames swap.
    const dx = col * CELL_W + Math.round((CELL_W - dw) / 2);
    const dy = row * CELL_H + (CELL_H - dh);
    drawFace(img, box, rgba, outW, dx, dy, scale);
  }
}

await Bun.write(OUT, encodePng(outW, outH, rgba));

const counts = grid.map((b) => b.length).join("+");
const scales = rowScale.map((s) => s.toFixed(3)).join(", ");
console.log(`${faces.length} faces (${counts}) → ${OUT}  ${outW}×${outH}, cell ${CELL_W}×${CELL_H}, row scales ${scales}`);
console.log(`${(Bun.file(OUT).size / 1024).toFixed(1)} KB`);
