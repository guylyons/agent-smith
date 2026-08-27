// Renders the worker body wearing each gear to a standalone HTML file so the
// pixel art can be eyeballed. Throwaway dev aid — run with `bun scripts/preview-gear.ts`.
import { spriteRects, GEARS, PALETTES } from "../src/ui/sprite-data";
import { writeFileSync } from "node:fs";

const SCALE = 14;
function svg(gear: string) {
  const rects = spriteRects({ body: "worker", gear, palette: PALETTES[0] });
  const cells = rects
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="1" height="1" fill="${r.fill}"/>`)
    .join("");
  return `<div class="cell"><svg width="${16 * SCALE}" height="${24 * SCALE}" viewBox="0 0 16 24" shape-rendering="crispEdges">${cells}</svg><div class="lbl">${gear}</div></div>`;
}

const body = ["__none__", ...GEARS].map(svg).join("");
const html = `<!doctype html><meta charset="utf8"><style>
  body{background:#0b0f1a;margin:0;padding:24px;font:12px monospace;color:#cdd}
  .grid{display:flex;flex-wrap:wrap;gap:20px}
  .cell{background:#141a2b;padding:10px;border:1px solid #26304a;text-align:center}
  .lbl{margin-top:8px;letter-spacing:1px;color:#8fc0ff}
</style><div class="grid">${body}</div>`;
writeFileSync(new URL("../preview-gear.html", import.meta.url), html);
console.log("wrote preview-gear.html");
