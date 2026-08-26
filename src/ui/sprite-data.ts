const BASE = [
  "................",
  "................",
  "....OOOOOOO.....",
  "...OHHHHHHHO....",
  "..OHHHHHHHHHO...",
  "..OHSSSSSSSHO...",
  "..OSSSSSSSSSO...",
  "..OSSEWSSEWSO...",
  "..OSSEWSSEWSO...",
  "..OSSSSSSSSSO...",
  "..OSssSSSssSO...",
  "...OSSSSSSSO....",
  "....OSSSSSO.....",
  "...OBBBBBBBO....",
  "..OBBBGGGBBBO...",
  ".OSBBGGGGGBBSO..",
  ".OSBBBGGGBBBSO..",
  ".OOBBBBBBBBBOO..",
  "...OPPPPPPPO....",
  "...OPPPPPPPO....",
  "...OPPPOPPPO....",
  "...OPPO.OPPO....",
  "..OFFFO.OFFFO...",
  "..OOOOO.OOOOO..."
];

const GEAR = {
  headset:[
    {at:1, rows:[
      "....OOOOOOO.....",
      "...OGGGGGGGO....",
      "...OGOOOOOGO...."]},
    {at:6, rows:[
      ".GG..........GG.",
      ".GG..........GG.",
      ".GG..........GG.",
      "..G.............",
      "...G............"]}
  ],
  goggles:[
    {at:2, rows:[
      "....OOOOOOO.....",
      "...OGGGGGGGO....",
      "..OGWWGGGWWGO..."]}
  ],
  hood:[
    {at:1, rows:[
      "....OOOOOOO.....",
      "...OGGGGGGGO....",
      "..OGGGGGGGGGO...",
      "..OGGSSSSSGGO...",
      "..OGSSSSSSSGO..."]},
    {at:6, rows:[
      ".OG.........GO..",
      ".OG.........GO..",
      ".OG.........GO..",
      "..O.........O..."]}
  ],
  visor:[
    {at:3, rows:[
      "...OOOOOOOOO....",
      "..OGGGGGGGGGO..."]},
    {at:6, rows:[
      ".........OOO....",
      ".........OGO....",
      ".........OOO...."]}
  ],
  topknot:[
    {at:0, rows:[
      ".......GG.......",
      "......OGGO......",
      "....OOOHHHOO...."]},
    {at:5, rows:[
      "............GO..",
      "............GO.."]}
  ]
};

export interface SpritePalette { O: string; H: string; B: string; G: string; P: string; }

export function spriteRects({ gear, palette }: { gear: string; palette: SpritePalette }) {
  const pal: Record<string, string> = {
    O: palette.O, H: palette.H, S: "#f0c6a0", s: "#d49f79", E: palette.O,
    W: "#ffffff", B: palette.B, G: palette.G, P: palette.P, F: "#2a2118",
  };
  const grid = BASE.map((r) => [...r]);
  (GEAR[gear as keyof typeof GEAR] || []).forEach((layer) =>
    layer.rows.forEach((row, i) =>
      [...row].forEach((c, x) => { if (c !== ".") grid[layer.at + i][x] = c; })));
  const rects: { x: number; y: number; fill: string }[] = [];
  grid.forEach((row, y) => row.forEach((c, x) => {
    if (pal[c]) rects.push({ x, y, fill: pal[c] });
  }));
  return rects;
}

export const PALETTES: SpritePalette[] = [
  { O: "#101a2e", H: "#3f2b1e", B: "#4a7ec9", G: "#8fc0ff", P: "#26406b" },
  { O: "#2a1410", H: "#7a2f2f", B: "#c9673a", G: "#f2b134", P: "#6e3a22" },
  { O: "#171238", H: "#2b2b3d", B: "#6a5acd", G: "#b7a8ff", P: "#3a3168" },
  { O: "#0e2a20", H: "#4a3a1e", B: "#3f8f6a", G: "#4fbf6a", P: "#245140" },
  { O: "#1d2030", H: "#4a4a4a", B: "#8a8fa8", G: "#d8dcf0", P: "#4c5068" },
];
export const GEARS = ["headset", "goggles", "hood", "visor", "topknot"];
const ROLE_GEAR: Record<string, string> = {
  "Ticket triage": "headset", "Component build": "goggles", "Migration": "hood",
  "Test & profile": "visor", "Docs & changelog": "topknot",
};

function hash(s: string): number {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function paletteFor(sessionId: string, role: string) {
  const h = hash(sessionId);
  return { palette: PALETTES[h % PALETTES.length], gear: ROLE_GEAR[role] ?? GEARS[h % GEARS.length] };
}
