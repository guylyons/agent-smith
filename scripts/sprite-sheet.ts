// Dev-only: rasterize every sprite body into a zoomed PNG contact sheet so the
// pixel art can be eyeballed. Run: bun run scripts/sprite-sheet.ts [out.png] [bodyFilter]
import { deflateSync } from "node:zlib";
import { BODIES, spriteRects, PALETTES } from "../src/ui/sprite-data";

const SCALE = Number(process.env.SCALE) || 9;   // px per sprite cell
const CW = 16, CH = 24;   // sprite grid
const PAD = 10;           // gap between sprites
const LABEL = 12;         // label strip height
const COLS = Number(process.env.COLS) || 6;

const out = process.argv[2] || "sprite-sheet.png";
const only = process.argv[3];               // optional substring filter
const bg = [24, 22, 30];                    // dark card-ish backdrop

// Guard: every row must be exactly 16 cells, or the grid shears.
for (const [id, def] of Object.entries(BODIES)) {
  def.rows.forEach((r, y) => {
    if (r.length !== 16) console.error(`!! ${id} row ${y} is ${r.length} chars (need 16): "${r}"`);
  });
  if (def.rows.length !== 24) console.error(`!! ${id} has ${def.rows.length} rows (need 24)`);
}

const want = only ? only.split(",") : null;
const ids = Object.keys(BODIES).filter((id) => !want || want.some((w) => id.includes(w)));
const cellW = CW * SCALE + PAD;
const cellH = CH * SCALE + LABEL + PAD;
const rows = Math.ceil(ids.length / COLS);
const W = COLS * cellW + PAD;
const H = rows * cellH + PAD;

const img = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) { img[i*3]=bg[0]; img[i*3+1]=bg[1]; img[i*3+2]=bg[2]; }

function px(x: number, y: number, hex: string) {
  if (x<0||y<0||x>=W||y>=H) return;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  const o = (y*W+x)*3; img[o]=r; img[o+1]=g; img[o+2]=b;
}
function block(px0:number, py0:number, hex:string) {
  for (let dy=0; dy<SCALE; dy++) for (let dx=0; dx<SCALE; dx++) px(px0+dx, py0+dy, hex);
}
// tiny 3x5 label font (only chars we need)
const FONT: Record<string,string[]> = {
  A:["010","101","111","101","101"],B:["110","101","110","101","110"],C:["011","100","100","100","011"],
  D:["110","101","101","101","110"],E:["111","100","110","100","111"],F:["111","100","110","100","100"],
  G:["011","100","101","101","011"],H:["101","101","111","101","101"],I:["111","010","010","010","111"],
  J:["001","001","001","101","010"],K:["101","110","100","110","101"],L:["100","100","100","100","111"],
  M:["101","111","111","101","101"],N:["101","111","111","111","101"],O:["010","101","101","101","010"],
  P:["110","101","110","100","100"],Q:["010","101","101","110","011"],R:["110","101","110","101","101"],
  S:["011","100","010","001","110"],T:["111","010","010","010","010"],U:["101","101","101","101","111"],
  V:["101","101","101","010","010"],W:["101","101","111","111","101"],X:["101","101","010","101","101"],
  Y:["101","101","010","010","010"],Z:["111","001","010","100","111"]," ":["000","000","000","000","000"],
};
function text(x0:number, y0:number, s:string, hex:string) {
  let cx = x0;
  for (const ch of s.toUpperCase()) {
    const g = FONT[ch] || FONT[" "];
    g.forEach((r,ry)=>[...r].forEach((c,rx)=>{ if(c==="1") px(cx+rx, y0+ry, hex); }));
    cx += 4;
  }
}

ids.forEach((id, i) => {
  const col = i % COLS, row = Math.floor(i / COLS);
  const ox = PAD + col*cellW, oy = PAD + row*cellH;
  const def = BODIES[id];
  // use palette 4 (the industrial grey) for the recoloring bodies; fixed-color bodies ignore it
  const rects = spriteRects({ body: id, gear: "none", palette: PALETTES[4] });
  rects.forEach((r) => block(ox + r.x*SCALE, oy + r.y*SCALE, r.fill));
  if (process.env.GRID) {                        // faint cell grid for editing
    for (let gx=0; gx<=CW; gx++) for (let y=0; y<CH*SCALE; y++) px(ox+gx*SCALE, oy+y, "#3a3a48");
    for (let gy=0; gy<=CH; gy++) for (let x=0; x<CW*SCALE; x++) px(ox+x, oy+gy*SCALE, "#3a3a48");
  }
  text(ox, oy + CH*SCALE + 3, def.label, "#c8ccd8");
});

// ---- PNG encode (RGB, no filter) ----
const raw = new Uint8Array(H * (1 + W*3));
for (let y=0; y<H; y++) {
  raw[y*(1+W*3)] = 0;
  for (let x=0; x<W*3; x++) raw[y*(1+W*3)+1+x] = img[y*W*3+x];
}
const crcTable = (()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c;}return t;})();
function crc32(buf:Uint8Array){let c=0xffffffff;for(let i=0;i<buf.length;i++)c=crcTable[(c^buf[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(type:string, data:Uint8Array){
  const t = new Uint8Array(4); for(let i=0;i<4;i++)t[i]=type.charCodeAt(i);
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
  const body = new Uint8Array(t.length+data.length); body.set(t); body.set(data, t.length);
  const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
dv.setUint32(0, W); dv.setUint32(4, H); ihdr[8]=8; ihdr[9]=2; // 8-bit, RGB
const png = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", new Uint8Array(0)),
]);
await Bun.write(out, png);
console.log(`wrote ${out} (${W}x${H}, ${ids.length} bodies)`);
