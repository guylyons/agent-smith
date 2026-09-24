// Drawing the fight strip: the corridor, the two sprites, the fire and the
// motion tracker, onto a 2D canvas from a fight.ts World. Split from
// FightStrip.tsx so the component only owns the loop and its lifecycle.
import { muzzle, particleColor, type World } from "./fight";
import { RIP_FRAMES, XENO_FRAMES, type Frame } from "./fight-sprites";

export interface Scene { w: number; h: number; px: number; bg: HTMLCanvasElement; shade: HTMLCanvasElement; font: string; }

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// Fixed colours, like the film cast's: this is a window onto a dark corridor
// on every theme, so the fire has something to light.
const WALL_TOP = "#0b0e16", WALL_BOT = "#131a29";
const SEAM = "#06080d", SEAM_HI = "#1b2233", RIB = "#171d2b";
const PIPE = "#1c2332", PIPE_HI = "#2c3548";
const DECK = "#1b2130", DECK_DOT = "#2a3347", DECK_EDGE = "#3a4560";
const HAZARD = "#6b5317";
const TRACKER = "#7fe07f";

export function makeScene(w: number, h: number, px: number): Scene {
  const floor = h - 3;
  const bg = canvas(w, h);
  const g = bg.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, WALL_TOP); grad.addColorStop(1, WALL_BOT);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  // Pipes along the ceiling, with brackets.
  g.fillStyle = PIPE; g.fillRect(0, 0, w, 3);
  g.fillStyle = PIPE_HI; g.fillRect(0, 1, w, 1);
  for (let x = 10; x < w; x += 32) { g.fillStyle = SEAM; g.fillRect(x, 0, 2, 4); }
  // Wall panels: seams, a rib, the odd hazard-striped kick plate.
  g.fillStyle = RIB; g.fillRect(0, 11, w, 1);
  for (let x = 0, i = 0; x < w; x += 36, i++) {
    g.fillStyle = SEAM; g.fillRect(x, 3, 1, floor - 3);
    g.fillStyle = SEAM_HI; g.fillRect(x + 1, 3, 1, floor - 3);
    if (i % 5 === 3) {
      for (let s = 0; s < 34; s++) {
        g.fillStyle = Math.floor((s + 16) / 3) % 2 ? HAZARD : SEAM;
        g.fillRect(x + 2 + s, floor - 3, 1, 3);
      }
    }
  }
  // Deck grating.
  g.fillStyle = DECK; g.fillRect(0, floor, w, h - floor);
  g.fillStyle = DECK_EDGE; g.fillRect(0, floor, w, 1);
  g.fillStyle = DECK_DOT;
  for (let x = 1; x < w; x += 2) g.fillRect(x, floor + 2, 1, 1);

  // Darkness closing in at both ends, so it comes out of the dark.
  const shade = canvas(w, h);
  const s = shade.getContext("2d")!;
  const edge = Math.min(40, w / 5);
  const l = s.createLinearGradient(0, 0, edge, 0);
  l.addColorStop(0, "rgba(3,4,8,.95)"); l.addColorStop(1, "rgba(3,4,8,0)");
  s.fillStyle = l; s.fillRect(0, 0, edge, h);
  const r = s.createLinearGradient(w - edge, 0, w, 0);
  r.addColorStop(0, "rgba(3,4,8,0)"); r.addColorStop(1, "rgba(3,4,8,.95)");
  s.fillStyle = r; s.fillRect(w - edge, 0, edge, h);
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
  return { w, h, px, bg, shade, font: `bold 4px ${mono}` };
}

/** A sprite frame drawn once to its own small canvas, flipped and tinted as asked. */
function sprite(cache: Map<string, HTMLCanvasElement>, name: string, f: Frame, flip: boolean, tint: "" | "flash" | "hot"): HTMLCanvasElement {
  const key = `${name}|${flip}|${tint}`;
  let c = cache.get(key);
  if (c) return c;
  c = canvas(f.w, f.h);
  const g = c.getContext("2d")!;
  f.rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const col = f.colors[ch];
    if (!col) return;
    g.fillStyle = tint === "flash" ? "#ffffff" : tint === "hot" ? mix(col, "#ff5a14", 0.45) : col;
    g.fillRect(flip ? f.w - 1 - x : x, y, 1, 1);
  }));
  cache.set(key, c);
  return c;
}

export function drawFight(ctx: CanvasRenderingContext2D, w: World, sc: Scene, cache: Map<string, HTMLCanvasElement>) {
  ctx.setTransform(sc.px, 0, 0, sc.px, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = WALL_TOP;
  ctx.fillRect(0, 0, sc.w, sc.h);
  const sx = w.shake ? Math.round((Math.random() - 0.5) * 2 * w.shake) : 0;
  const sy = w.shake ? Math.round((Math.random() - 0.5) * 2 * w.shake) : 0;
  ctx.translate(sx, sy);
  ctx.drawImage(sc.bg, 0, 0);

  // Warning lamps along the wall.
  for (let x = 28, i = 0; x < sc.w; x += 72, i++) {
    const on = i % 3 === 0 ? Math.sin(w.t * 3 + i) > 0 : i % 3 === 1 ? true : Math.sin(w.t * 1.3 + i * 2) > 0.6;
    ctx.fillStyle = on ? (i % 3 === 1 ? "#3fae5a" : "#e0533d") : "#2a1414";
    ctx.fillRect(x, 7, 2, 1);
  }

  // Firelight: a warm wash over the corridor wherever the flames are.
  let n = 0, cx = 0, cy = 0;
  for (const p of w.parts) if (p.kind === "flame") { n++; cx += p.x; cy += p.y; }
  if (n) {
    cx /= n; cy /= n;
    const glow = Math.min(1, n / 120) * (0.85 + Math.random() * 0.15);
    const rad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 60);
    rad.addColorStop(0, `rgba(255,150,50,${0.45 * glow})`);
    rad.addColorStop(1, "rgba(255,110,30,0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = rad; ctx.fillRect(cx - 60, cy - 60, 120, 120);
    ctx.globalCompositeOperation = "source-over";
  }

  // The xenomorph.
  const x = w.xeno;
  if (x.present) {
    const f = XENO_FRAMES[x.frame];
    const hot = x.burn > 0 && Math.floor(w.t * 14) % 2 === 0;
    ctx.globalAlpha = Math.max(0, x.fade);
    ctx.drawImage(sprite(cache, `x-${x.frame}`, f, x.face === 1, hot ? "hot" : ""), Math.round(x.x), Math.round(w.floor - f.h + x.y));
    ctx.globalAlpha = 1;
  }

  // Ripley.
  const r = w.rip;
  const rf = RIP_FRAMES[r.frame];
  const flash = r.hurt > 0 && Math.floor(r.hurt * 20) % 2 === 0;
  const jx = (r.jitter > 0 || (r.firing && !r.sputter)) ? Math.round((Math.random() - 0.5) * (r.jitter > 0 ? 2 : 1)) : 0;
  ctx.drawImage(sprite(cache, `r-${r.frame}`, rf, r.dir === -1, flash ? "flash" : ""), Math.round(r.x) + jx, w.floor - rf.h);

  // The pilot light at the nozzle, flickering while she's not firing.
  if (!r.firing) {
    const m = muzzle(w);
    ctx.fillStyle = Math.random() < 0.5 ? "#6cc4ff" : "#ffd166";
    ctx.fillRect(Math.round(m.x) - (r.dir === -1 ? 1 : 0) + jx, Math.round(m.y) - 1, 1, 1);
  }

  // Smoke, ash, dust and acid under the fire; the fire itself adds light.
  for (const p of w.parts) {
    if (p.kind === "flame" || p.kind === "ember") continue;
    const { color, alpha } = particleColor(p);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = color;
    const s = Math.round(p.size);
    ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
  }
  ctx.globalCompositeOperation = "lighter";
  for (const p of w.parts) {
    if (p.kind !== "flame" && p.kind !== "ember") continue;
    const { color, alpha } = particleColor(p);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = color;
    const s = Math.round(p.size);
    ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  ctx.setTransform(sc.px, 0, 0, sc.px, 0, 0);
  ctx.drawImage(sc.shade, 0, 0);

  // The motion tracker, pinging when something's coming.
  if (w.tracker > 0) {
    const ping = (w.tracker * 2.5) % 1;
    ctx.globalAlpha = Math.min(1, w.tracker);
    ctx.fillStyle = TRACKER;
    ctx.fillRect(4, 5, 1, 1);
    ctx.strokeStyle = TRACKER;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = Math.min(1, w.tracker) * (1 - ping);
    ctx.beginPath(); ctx.arc(4.5, 5.5, 1 + ping * 4, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = Math.min(1, w.tracker) * (Math.floor(w.t * 4) % 2 ? 1 : 0.5);
    ctx.font = sc.font;
    ctx.fillText("MOTION", 9, 7);
    ctx.globalAlpha = 1;
  }
}

/** Blend two #rrggbb colours. */
function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
