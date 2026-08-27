// Regenerates src/ui/favicon.svg from a 16x16 pixel grid, in the sprite art
// style. Run with `bun scripts/gen-favicon.ts` after editing the grid below.
// A rounded "agent" bot-face with big eyes reads cleanly down to 16px.
import { writeFileSync } from "node:fs";

// App palette (from sprite-data PALETTES[0]) plus white.
const COLORS: Record<string, string> = {
  O: "#101a2e", // outline / dark navy
  B: "#4a7ec9", // blue face
  G: "#8fc0ff", // light mouth
  W: "#ffffff", // eyes
  ".": "",      // transparent
};

const ICON = [
  "................",
  "..OOOOOOOOOOOO..",
  ".OOBBBBBBBBBBOO.",
  ".OBBBBBBBBBBBBO.",
  ".OBWWWBBBBWWWBO.",
  ".OBWWWBBBBWWWBO.",
  ".OBWWWBBBBWWWBO.",
  ".OBBBBBBBBBBBBO.",
  ".OBBBBBBBBBBBBO.",
  ".OBBBBBBBBBBBBO.",
  ".OBBGGGGGGGGBBO.",
  ".OBBBBBBBBBBBBO.",
  ".OOBBBBBBBBBBOO.",
  "..OOOOOOOOOOOO..",
  "................",
  "................",
];

function svg(grid: string[]): string {
  const n = grid.length;
  const rects: string[] = [];
  // Merge consecutive same-colour cells in a row into one rect — a favicon
  // loads on every page, so keep the file small.
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const fill = COLORS[row[x]];
      if (!fill) { x++; continue; }
      let w = 1;
      while (x + w < row.length && COLORS[row[x + w]] === fill) w++;
      rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${fill}"/>`);
      x += w;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

writeFileSync(new URL("../src/ui/favicon.svg", import.meta.url), svg(ICON));
console.log("wrote src/ui/favicon.svg");
