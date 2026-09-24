// The rules of the fight strip at the top of THE LINE: Ripley and her
// flamethrower against a xenomorph, a new randomly picked round each time the
// last one ends. Pure and DOM-free, like game.ts, so it can be unit-tested and
// driven to a fixed frame for a still; FightStrip.tsx only draws the World.
//
// Units are the art's own pixels: x runs right along the corridor, y runs down,
// and `floor` is the line everyone's feet stand on.
import { RIP_FRAMES, XENO_FRAMES, RIP_MUZZLE, type RipFrame, type XenoFrame } from "./fight-sprites";

export type Rng = () => number;

/** A small seeded PRNG, so a test (or the reduced-motion still) replays exactly. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PartKind = "flame" | "smoke" | "acid" | "ember" | "ash" | "dust";
export interface Particle { kind: PartKind; x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; }

export interface Ripley {
  x: number; dir: 1 | -1; frame: RipFrame;
  /** Flamethrower trigger held, how hard it's pushing, and whether it's choking. */
  firing: boolean; power: number; sputter: boolean;
  /** Seconds the trigger has been held this burst. */
  fireT: number;
  walkT: number; hurt: number; vx: number; jitter: number;
}

export interface Xeno {
  present: boolean; x: number; y: number; vy: number;
  /** -1 faces left (how it's drawn), 1 faces right. */
  face: 1 | -1; frame: XenoFrame; walkT: number;
  burn: number; dead: boolean;
  /** 1 fully there, down to 0 as a dead one crumbles to ash. */
  fade: number;
}

export const SCENARIOS = ["flee", "ash", "leap", "sputter", "drop"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface World {
  w: number; h: number; floor: number; t: number;
  /** How far the flame reaches — shorter on a narrow strip, so the fight still fits. */
  range: number;
  /** Which side the xenomorph comes from this round. */
  side: 1 | -1;
  rip: Ripley; xeno: Xeno;
  parts: Particle[];
  fires: { x: number; life: number; max: number }[];
  /** Screen shake, in pixels; decays on its own. */
  shake: number;
  /** Seconds left on the motion tracker's warning. */
  tracker: number;
  scenario: Scenario | "patrol";
  rounds: number;
  rng: Rng;
  opts: FightOpts;
  beat: Beat | null;
}

export interface FightOpts {
  /** Always play this scenario (tests, the still frame). */
  only?: Scenario;
  /** Skip the patrol lull between rounds. */
  quick?: boolean;
}

const MAX_PARTS = 700;
const RIP_W = RIP_FRAMES.stand.w;

export function createFight(w: number, h: number, rng: Rng, opts: FightOpts = {}): World {
  const world: World = {
    w, h, floor: h - 3, t: 0, range: flameRange(w), side: 1,
    rip: { x: Math.round(w * 0.2), dir: 1, frame: "stand", firing: false, power: 1, sputter: false, fireT: 0, walkT: 0, hurt: 0, vx: 0, jitter: 0 },
    xeno: { present: false, x: w + 10, y: 0, vy: 0, face: -1, frame: "walkA", walkT: 0, burn: 0, dead: false, fade: 1 },
    parts: [], fires: [], shake: 0, tracker: 0, scenario: "patrol", rounds: 0, rng, opts, beat: null,
  };
  return world;
}

/** The strip was resized: keep everyone on it. */
export function resizeFight(world: World, w: number, h: number): void {
  world.w = w; world.h = h; world.floor = h - 3; world.range = flameRange(w);
  world.rip.x = clamp(world.rip.x, 2, Math.max(2, w - RIP_W - 2));
}

export function flameRange(w: number): number { return clamp(Math.round(w * 0.3), 36, 64); }

// ---- the director ------------------------------------------------------------
// A round is one Beat: a function ticked every step that returns true once it's
// finished. Small beats compose with `seq` (one after another) and `all` (side
// by side, done when every one is).

type Beat = (w: World, dt: number) => boolean;

const wait = (s: number): Beat => { let t = 0; return (_w, dt) => (t += dt) >= s; };
const act = (fn: (w: World) => void): Beat => (w) => { fn(w); return true; };
function seq(...beats: Beat[]): Beat {
  let i = 0;
  return (w, dt) => {
    while (i < beats.length) {
      if (!beats[i](w, dt)) return false;
      i++; dt = 0;
    }
    return true;
  };
}
function all(...beats: Beat[]): Beat {
  const done = beats.map(() => false);
  return (w, dt) => {
    beats.forEach((b, i) => { if (!done[i]) done[i] = b(w, dt); });
    return done.every(Boolean);
  };
}

/** Space between Ripley and the xenomorph, edge to edge, on the xeno's side. */
export function gap(w: World): number {
  const xw = XENO_FRAMES[w.xeno.frame].w;
  return w.side === 1 ? w.xeno.x - (w.rip.x + RIP_W) : w.rip.x - (w.xeno.x + xw);
}

/** Where the flame leaves the nozzle, in world pixels. */
export function muzzle(w: World): { x: number; y: number } {
  const f = RIP_FRAMES[w.rip.frame];
  return { x: w.rip.dir === 1 ? w.rip.x + RIP_MUZZLE.x : w.rip.x, y: w.floor - f.h + RIP_MUZZLE.y };
}

function ripWalkTo(tx: number): Beat {
  return (w, dt) => {
    const r = w.rip;
    const d = tx - r.x;
    if (Math.abs(d) < 0.5) { r.x = tx; r.frame = "stand"; return true; }
    r.dir = d > 0 ? 1 : -1;
    r.x += Math.sign(d) * Math.min(Math.abs(d), 30 * dt);
    r.walkT += dt;
    r.frame = Math.floor(r.walkT / 0.2) % 2 ? "step" : "stand";
    return false;
  };
}

function ripFire(s: number, power = 1, sputter = false): Beat {
  let t = 0;
  return (w, dt) => {
    const r = w.rip;
    if (t === 0) { r.firing = true; r.power = power; r.sputter = sputter; r.fireT = 0; r.frame = "brace"; }
    t += dt;
    if (t >= s) { r.firing = false; r.sputter = false; r.frame = "stand"; return true; }
    return false;
  };
}

function ripBackstep(dist: number, s: number): Beat {
  let t = 0;
  return (w, dt) => {
    t += dt;
    w.rip.x -= w.rip.dir * (dist / s) * dt;
    w.rip.x = clamp(w.rip.x, 2, w.w - RIP_W - 2);
    return t >= s;
  };
}

function xenoSpawn(): Beat {
  return act((w) => {
    const xw = XENO_FRAMES.walkA.w;
    Object.assign(w.xeno, {
      present: true, y: 0, vy: 0, burn: 0, dead: false, fade: 1, frame: "walkA", walkT: 0,
      x: w.side === 1 ? w.w + 4 : -xw - 4, face: w.side === 1 ? -1 : 1,
    });
  });
}

function xenoWalk(x: Xeno, step: number, dt: number) {
  x.walkT += dt * step;
  x.frame = Math.floor(x.walkT) % 2 ? "walkB" : "walkA";
}

/** Stalk in until `stopGap` from Ripley, quick enough that a wide strip isn't a long wait. */
function xenoApproach(stopGap: number, speed?: number): Beat {
  let v = speed ?? 0;
  return (w, dt) => {
    const x = w.xeno;
    const left = gap(w) - stopGap;
    if (!v) v = clamp(left / 3.2, 38, 130);
    if (left <= 0.01) { x.frame = "walkA"; return true; }
    x.face = w.side === 1 ? -1 : 1;
    x.x -= w.side * Math.min(left, v * dt);
    xenoWalk(x, v / 14, dt);
    return false;
  };
}

function xenoPose(frame: XenoFrame, s: number, shake = 0): Beat {
  let t = 0;
  return (w, dt) => {
    if (t === 0) { w.xeno.frame = frame; w.shake = Math.max(w.shake, shake); }
    t += dt;
    if (t >= s) { w.xeno.frame = "walkA"; return true; }
    return false;
  };
}

function xenoFlee(): Beat {
  return (w, dt) => {
    const x = w.xeno;
    x.face = w.side === 1 ? 1 : -1;
    x.x += w.side * 150 * dt;
    xenoWalk(x, 12, dt);
    const xw = XENO_FRAMES[x.frame].w;
    if (x.x > w.w + 8 || x.x < -xw - 8) { x.present = false; return true; }
    return false;
  };
}

/** A slow, burning advance — it isn't done yet. */
function xenoAdvance(dist: number, s: number): Beat {
  let t = 0;
  return (w, dt) => {
    t += dt;
    const room = Math.max(0, gap(w) - 4);
    w.xeno.x -= w.side * Math.min(room, (dist / s) * dt);
    xenoWalk(w.xeno, 4, dt);
    return t >= s;
  };
}

/** Collapse, burn, and crumble away to ash. */
function xenoDie(): Beat {
  return seq(
    act((w) => {
      const x = w.xeno;
      // The dead frame is flatter; keep it lying where it stood.
      x.dead = true; x.frame = "dead"; x.burn = Math.max(x.burn, 2.6); w.shake = Math.max(w.shake, 2);
      dust(w, x.x + XENO_FRAMES.dead.w / 2, 10);
    }),
    wait(1.4),
    (w, dt) => {
      const x = w.xeno;
      x.fade -= dt / 1.5;
      if (w.rng() < 0.9) {
        const f = XENO_FRAMES.dead;
        spawn(w, "ash", x.x + w.rng() * f.w, w.floor - w.rng() * f.h, (w.rng() - 0.5) * 8, -6 - w.rng() * 10, 1.2 + w.rng(), 1);
      }
      if (x.fade <= 0) { x.present = false; x.dead = false; x.burn = 0; return true; }
      return false;
    },
  );
}

/** Leap at Ripley, landing `landGap` from her. */
function xenoLeap(landGap: number, s: number, height: number): Beat {
  let t = 0, x0 = 0, x1 = 0;
  return (w, dt) => {
    const x = w.xeno;
    if (t === 0) { x0 = x.x; x1 = x.x - w.side * (gap(w) - landGap); x.frame = "leap"; }
    t += dt;
    const p = Math.min(1, t / s);
    x.x = x0 + (x1 - x0) * p;
    x.y = -Math.sin(p * Math.PI) * height;
    if (p >= 1) { x.y = 0; x.frame = "walkA"; w.shake = Math.max(w.shake, 2); dust(w, x.x + XENO_FRAMES.walkA.w / 2, 6); return true; }
    return false;
  };
}

/** Drop out of a ceiling vent in front of her. */
function xenoDrop(landGap: number): Beat {
  let started = false;
  return (w, dt) => {
    const x = w.xeno;
    if (!started) {
      started = true;
      const xw = XENO_FRAMES.walkA.w;
      Object.assign(x, {
        present: true, burn: 0, dead: false, fade: 1, frame: "leap", vy: 0,
        y: -w.h, face: w.side === 1 ? -1 : 1,
        x: w.side === 1 ? w.rip.x + RIP_W + landGap : w.rip.x - landGap - xw,
      });
    }
    x.vy += 420 * dt;
    x.y += x.vy * dt;
    if (x.y >= 0) {
      x.y = 0; x.vy = 0; x.frame = "walkA";
      w.shake = Math.max(w.shake, 3);
      dust(w, x.x + XENO_FRAMES.walkA.w / 2, 12);
      return true;
    }
    return false;
  };
}

/** The tail catches her: a flash, a shove backwards, a jolt. */
const tailHit = act((w) => {
  w.rip.hurt = 0.35; w.rip.vx = -w.rip.dir * 70; w.shake = Math.max(w.shake, 3);
  w.rip.firing = false; w.rip.frame = "stand";
});

/** The ending of a torching: it either runs for it or goes down. */
const finish = (w: World): Beat => (w.rng() < 0.5 ? xenoFlee() : xenoDie());

function round(w: World): Beat {
  const rng = w.rng;
  const r = (a: number, b: number) => a + rng() * (b - a);
  const kind = w.opts.only ?? SCENARIOS[Math.floor(rng() * SCENARIOS.length)];
  const side: 1 | -1 = rng() < 0.7 ? 1 : -1;
  const quick = !!w.opts.quick;
  const range = w.range;

  // Where she makes her stand: room on the xeno's side for the flame and it.
  const room = range + XENO_FRAMES.walkA.w + 8;
  const lo = side === 1 ? 4 : Math.min(room, w.w - RIP_W - 4);
  const hi = side === 1 ? Math.max(4, w.w - RIP_W - room) : w.w - RIP_W - 4;
  const stand = Math.round(lo + rng() * Math.max(0, hi - lo));
  // Now and then it comes from behind and she has to whip round.
  const behind = side === -1 && rng() < 0.6;

  const intro = seq(
    act((w) => { w.scenario = "patrol"; w.side = side; }),
    wait(quick ? 0 : r(1.2, 3.5)),
    ripWalkTo(stand),
    wait(quick ? 0 : r(0.3, 0.9)),
    act((w) => { w.rip.dir = behind ? 1 : side; w.tracker = 2.4; w.scenario = kind; }),
    wait(quick ? 0 : r(0.5, 1.2)),
  );
  const turn = act((w) => { w.rip.dir = side; });

  let fight: Beat;
  switch (kind) {
    case "flee":
      fight = seq(
        xenoSpawn(), all(xenoApproach(range * r(0.55, 0.85)), seq(wait(0.8), turn)), turn,
        xenoPose("shriek", 0.45),
        all(ripFire(1.7), seq(wait(0.45), xenoPose("shriek", 0.55, 1), xenoFlee())),
      );
      break;
    case "ash":
      fight = seq(
        xenoSpawn(), all(xenoApproach(range * 0.8), seq(wait(0.8), turn)), turn,
        all(
          ripFire(3.4),
          seq(wait(0.4), xenoPose("shriek", 0.6, 1), all(xenoAdvance(20, 1.5), ripBackstep(8, 1.5)), xenoDie()),
        ),
      );
      break;
    case "leap":
      fight = seq(
        xenoSpawn(), all(xenoApproach(range * 1.2), seq(wait(0.8), turn)), turn,
        ripFire(0.5), xenoLeap(3, 0.5, 13), xenoPose("shriek", 0.15), tailHit, wait(0.55),
        all(ripFire(1.6), seq(wait(0.35), xenoPose("shriek", 0.45, 1), finish(w))),
      );
      break;
    case "sputter":
      fight = seq(
        xenoSpawn(), all(xenoApproach(range * 0.85), seq(wait(0.8), turn)), turn,
        ripFire(1.1, 0.7, true),
        all(act((w) => { w.rip.jitter = 0.7; }), seq(xenoApproach(10, 16), xenoPose("shriek", 0.6))),
        all(ripFire(1.9, 1.6), seq(wait(0.3), xenoPose("shriek", 0.55, 2), finish(w))),
      );
      break;
    case "drop":
      fight = seq(
        turn, wait(0.3), xenoDrop(r(14, 26)), xenoPose("shriek", 0.6, 1),
        all(ripFire(1.9), seq(wait(0.3), xenoPose("shriek", 0.5, 1), finish(w))),
      );
      break;
  }
  return seq(intro, fight, wait(quick ? 0 : r(0.8, 1.6)), act((w) => { w.rounds++; w.scenario = "patrol"; }));
}

// ---- physics -----------------------------------------------------------------

function spawn(w: World, kind: PartKind, x: number, y: number, vx: number, vy: number, life: number, size: number) {
  if (w.parts.length >= MAX_PARTS) w.parts.shift();
  w.parts.push({ kind, x, y, vx, vy, age: 0, life, size });
}

function dust(w: World, x: number, n: number) {
  for (let i = 0; i < n; i++) {
    spawn(w, "dust", x + (w.rng() - 0.5) * 12, w.floor - 1, (w.rng() - 0.5) * 50, -w.rng() * 14, 0.5 + w.rng() * 0.5, 1);
  }
}

function xenoBox(w: World) {
  const x = w.xeno, f = XENO_FRAMES[x.frame];
  const top = w.floor - f.h + x.y;
  return { x0: x.x, x1: x.x + f.w, y0: top, y1: top + f.h };
}

/** Advance the fight by `dt` seconds. */
export function stepFight(w: World, dt: number): void {
  const rng = w.rng;
  w.t += dt;
  if (!w.beat) w.beat = round(w);
  if (w.beat(w, dt)) w.beat = null;

  // Ripley: knockback, the hit flash, a gun that won't sit still.
  const r = w.rip;
  r.x = clamp(r.x + r.vx * dt, 2, Math.max(2, w.w - RIP_W - 2));
  r.vx *= Math.exp(-8 * dt);
  r.hurt = Math.max(0, r.hurt - dt);
  r.jitter = Math.max(0, r.jitter - dt);

  // The flamethrower.
  if (r.firing) {
    r.fireT += dt;
    const m = muzzle(w);
    const reach = w.range / 60;
    if (r.sputter) {
      // Choking on its fuel: a cough of flame now and then, and smoke.
      if (rng() < dt * 6) {
        for (let i = 0; i < 5; i++) spawn(w, "flame", m.x, m.y, r.dir * (40 + rng() * 40) * reach, (rng() - 0.5) * 16, 0.12 + rng() * 0.12, 1);
        spawn(w, "smoke", m.x, m.y, r.dir * 12, -8, 0.8, 2);
      }
    } else {
      const n = poisson(rng, 170 * r.power * dt);
      for (let i = 0; i < n; i++) {
        const speed = (105 + rng() * 55) * (0.85 + 0.2 * r.power) * reach;
        spawn(w, "flame", m.x, m.y + (rng() - 0.5) * 2, r.dir * speed, (rng() - 0.5) * 22 - 4,
          (0.32 + rng() * 0.26) * (r.power > 1 ? 1.2 : 1), 1);
      }
      if (r.power > 1) w.shake = Math.max(w.shake, 1.2);
    }
  } else {
    r.fireT = 0;
  }

  // Particles.
  let hits = 0;
  const box = w.xeno.present && !w.xeno.dead ? xenoBox(w) : null;
  // Take the old list: anything spawned while it's walked lands in the new
  // one and starts moving next step.
  const old = w.parts;
  w.parts = [];
  for (const p of old) {
    p.age += dt;
    if (p.age >= p.life) {
      if (p.kind === "flame" && rng() < 0.25) spawn(w, "smoke", p.x, p.y, p.vx * 0.2, -10, 0.6 + rng() * 0.6, 2);
      continue;
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    switch (p.kind) {
      case "flame":
        p.vy -= 55 * dt; p.vx *= Math.exp(-2.2 * dt);
        p.size = 1.5 + Math.min(2, (p.age / p.life) * 3);
        if (p.y > w.floor - 1) {
          // Rolling along the deck, sometimes catching.
          p.y = w.floor - 1; p.vy = -Math.abs(p.vy) * 0.2;
          if (w.fires.length < 10 && rng() < 0.015) w.fires.push({ x: p.x, life: 1.5 + rng() * 2, max: 3.5 });
        }
        if (box && p.age / p.life < 0.75 && p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1) hits++;
        break;
      case "smoke": p.vy -= 4 * dt; p.vx *= Math.exp(-1.5 * dt); p.size = 2 + (p.age / p.life) * 2; break;
      case "ember": p.vy += 20 * dt; break;
      case "ash": p.vx += (rng() - 0.5) * 20 * dt; p.vy += 2 * dt; break;
      case "dust": p.vx *= Math.exp(-5 * dt); p.vy += 30 * dt; if (p.y > w.floor - 1) { p.y = w.floor - 1; p.vy = 0; } break;
      case "acid":
        p.vy += 200 * dt;
        if (p.y >= w.floor - 1) {
          // Acid blood hits the deck and eats into it.
          spawn(w, "smoke", p.x, w.floor - 2, 0, -12, 0.7, 1);
          continue;
        }
        break;
    }
    w.parts.push(p);
  }

  // Torched.
  const x = w.xeno;
  if (hits > 0) {
    x.burn = Math.max(x.burn, 1.8);
    if (rng() < 0.12) {
      const b = xenoBox(w);
      spawn(w, "acid", b.x0 + rng() * (b.x1 - b.x0), b.y1 - 4, (rng() - 0.5) * 20, -20 - rng() * 20, 2, 1);
    }
  }
  if (x.present && x.burn > 0) {
    x.burn = Math.max(0, x.burn - dt);
    const b = xenoBox(w);
    const n = poisson(rng, (x.dead ? 45 : 70) * dt * x.fade);
    for (let i = 0; i < n; i++) {
      spawn(w, "flame", b.x0 + rng() * (b.x1 - b.x0), b.y0 + 2 + rng() * (b.y1 - b.y0 - 2), (rng() - 0.5) * 10, -8 - rng() * 14, 0.25 + rng() * 0.3, 1);
    }
    if (rng() < dt * 6) spawn(w, "ember", b.x0 + rng() * (b.x1 - b.x0), b.y0, (rng() - 0.5) * 30, -30 - rng() * 30, 0.8, 1);
  }

  // Patches of burning fuel on the deck.
  w.fires = w.fires.filter((f) => (f.life -= dt) > 0);
  for (const f of w.fires) {
    if (rng() < dt * 14 * (f.life / f.max + 0.2)) spawn(w, "flame", f.x + (rng() - 0.5) * 4, w.floor - 1, (rng() - 0.5) * 6, -12 - rng() * 12, 0.25 + rng() * 0.2, 1);
  }

  w.shake *= Math.exp(-9 * dt);
  if (w.shake < 0.05) w.shake = 0;
  w.tracker = Math.max(0, w.tracker - dt);
}

/** A single frame to show instead of the animation under reduced motion:
 *  mid-blast, the xenomorph reeling. Always the same frame. */
export function stillFight(w: number, h: number): World {
  const world = createFight(w, h, mulberry32(144), { only: "flee", quick: true });
  for (let i = 0; i < 60 * 30 && world.rip.fireT < 0.55; i++) stepFight(world, 1 / 60);
  return world;
}

// ---- colour ------------------------------------------------------------------

/** A particle's colour and opacity for its kind and age. Flame runs white-hot
 *  at the nozzle through yellow and orange to a dull red, then gutters out. */
export function particleColor(p: Particle): { color: string; alpha: number } {
  const k = p.age / p.life;
  switch (p.kind) {
    case "flame":
      if (k < 0.1) return { color: "#fff8e0", alpha: 1 };
      if (k < 0.28) return { color: "#ffe066", alpha: 1 };
      if (k < 0.5) return { color: "#ffa12b", alpha: 0.95 };
      if (k < 0.72) return { color: "#f2561d", alpha: 0.85 };
      return { color: "#9c2410", alpha: 0.7 * (1 - k) / 0.28 };
    case "smoke": return { color: "#4a4450", alpha: 0.45 * (1 - k) };
    case "ember": return { color: k < 0.5 ? "#ffd166" : "#ff7b2b", alpha: 1 - k * 0.6 };
    case "ash": return { color: "#8a8790", alpha: 0.8 * (1 - k) };
    case "dust": return { color: "#6d7488", alpha: 0.7 * (1 - k) };
    case "acid": return { color: "#b6ff3b", alpha: 1 };
  }
}

// ---- helpers -----------------------------------------------------------------

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** How many events land this step at an average of `mean` — steady emission
 *  whatever the frame rate. */
function poisson(rng: Rng, mean: number): number {
  let n = Math.floor(mean);
  if (rng() < mean - n) n++;
  return n;
}
