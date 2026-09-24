// The side-on cast for the fight strip at the top of THE LINE (FightStrip.tsx):
// Ripley with the M240 flamethrower, and the xenomorph. Same ASCII pixel-grid
// idea as sprite-alien.ts — `.` is transparent, every other letter looks up a
// color in the frame's legend — but these are drawn in profile, since the two
// of them face each other across the strip. Ripley is drawn facing right and
// the xenomorph facing left; the renderer mirrors either one to turn it round.
//
// Rows may be ragged: `frame` pads them to the widest, so the art can be
// written without counting trailing dots.

export interface Frame { w: number; h: number; rows: string[]; colors: Record<string, string>; }

function frame(colors: Record<string, string>, rows: string[]): Frame {
  const w = Math.max(...rows.map((r) => r.length));
  return { w, h: rows.length, rows: rows.map((r) => r.padEnd(w, ".")), colors };
}

// Ripley's legend matches her desk sprite in sprite-alien.ts (hair, grey tank
// top, khaki fatigues), plus the flamethrower: gunmetal, a glint, and the
// fuel canister slung under the barrel.
const RIPLEY = {
  O: "#1c1410", E: "#1c1410",
  S: "#f0c6a0", s: "#d49f79",
  H: "#4a2c1a", h: "#7a4a2c",
  T: "#c4c8cf", t: "#8e939c", u: "#dfe3ea",
  K: "#857748", k: "#5c5230",
  B: "#3a2a1e", b: "#5a4632",
  R: "#3b3f4a", r: "#6e7482", i: "#b4bac6",
  F: "#7a2a1c", f: "#b0452c",
};

const RIP_TOP = [
  ".......OOOOO",
  ".....OOHhhhHOO",
  "....OHhHHhhHHHO",
  "...OHHhHHHHhHHHO",
  "...OhHHHhHHHSSSO",
  "..OHHhHHHHHSSSESO",
  "..OHHHHhHHHSSSSSSO",
  "..OhHHHHhHHsSSSSO",
  "...OHHhHHHHOSSssO",
  "...OHHHhHOSSSSO",
  "....OOOOOSSSO",
  ".....OOuTTTTO",
  ".....OuTTTTTSO",
  ".....OuTTTtTSSO",
  ".....OTTTtTOSSOOOOOO",
  ".....OTTTTTOOSSrrrriO",
  ".....OTTTtTOSSRRRRRRO",
  ".....OKKKKKOOOOOfFFOO",
];

export const RIP_STAND = frame(RIPLEY, [
  ...RIP_TOP,
  "......OKKKKO...OFFO",
  "......OKKkKKO...OO",
  ".....OKKOOKKO",
  ".....OkKO.OKkO",
  "....OBBbO..OBBbO",
  "....OOOOO..OOOOO",
]);

export const RIP_STEP = frame(RIPLEY, [
  ...RIP_TOP,
  "......OKKKKO...OFFO",
  "......OKKkKO....OO",
  "......OKKKKO",
  "......OkKkO",
  ".....OBBbBO",
  ".....OOOOOO",
]);

// Braced to fire: feet planted wide, weight on the back leg.
export const RIP_BRACE = frame(RIPLEY, [
  ...RIP_TOP,
  "......OKKKKO...OFFO",
  ".....OKKOkKKO...OO",
  "....OKKO..OKKO",
  "...OkKO....OKkO",
  "..OBBbO....OBBbO",
  "..OOOOO....OOOOO",
]);

/** Where the flame leaves the nozzle, in Ripley's own pixels (facing right). */
export const RIP_MUZZLE = { x: RIP_STAND.w, y: 15.5 };

// The xenomorph: black biomech with a wet blue-grey gloss along the dome,
// silver teeth, dorsal tubes on the back and the tail raised behind it.
const XENO = {
  O: "#07080c",
  X: "#262b38", x: "#3d4456", g: "#5a6478", r: "#7d8aa3",
  b: "#9aa8c0",
  W: "#e8ecf0",
};

const XENO_BODY = [
  "..............................OO",
  ".............................ObO",
  "......OOOOO.................OxO",
  "....OOgrbbxOO...............OXO",
  "...OxgrxxxXXXOO..O.O.O......OXO",
  "..OxgxxxXXXXXXXOOgOgOgOO...OXO",
  ".OxxxXXXXXXXXXXXXXXXXXXXOOOXO",
  "OWWxOOXXXXXXxXXXXXXXXXXXXXXO",
  "OOWWOxOXXXXxgxXXXXXXXXXXXXO",
  ".OWOOOXXXxgxXXXXXXXxXXXXOO",
  "..OO.OXXOxXXOOOOXXxgxXXO",
];

export const XENO_WALK_A = frame(XENO, [
  ...XENO_BODY,
  ".....OXO.OXO...OXXOOXXXO",
  "....OXO..OXO...OXO..OXXO",
  "...OXO..OXO....OXO...OXO",
  "..OXO...OXO....OXO...OXXO",
  ".OOO...OOO....OOOO...OOOOO",
]);

export const XENO_WALK_B = frame(XENO, [
  ...XENO_BODY,
  ".....OXO..OXO..OXXOOXXXO",
  ".....OXO...OXO.OXO..OXXO",
  "....OXO....OXO..OXO..OXO",
  "....OXO.....OXO.OXO..OXXO",
  "...OOO.....OOO..OOO..OOOO",
]);

// Reared up with the jaws open and the inner jaw out: the hiss and the shriek.
export const XENO_SHRIEK = frame(XENO, [
  "........OOOOO",
  "......OOgrbbxOO",
  ".....OxgrxxxXXXOO",
  "....OxgxxxXXXXXXXO..O.O",
  "...OxxxXXXXXXXXXXXOOgOgO",
  "..OWxOOXXXXXXXXXXXXXXXXXOO",
  ".OWWO.OXXXXXXXXXXXXXXXXXXXO",
  "OWWO..OOXXXXxgxXXXXXXXXXXXXO",
  "OWOWWO.OXXXxgxXXXXXXXXOOXXXO",
  "OO.OWWOOXXXXXXXXXXXXXO.OXXO",
  ".OWWO.OXXOXXXXxXXXXXO..OXXO",
  "..OO..OXO.OXXXXXXXXO...OXO",
  ".....OXO...OXXOOXXXO..OXO",
  "....OXO....OXXO.OXXO.OXO",
  "....OO.....OXO..OXXOOXO",
  "..........OXO...OXXXXO",
  ".........OXO....OXXO",
  "........OXO.....OXO",
  "........OXO.....OXO",
  ".......OOOO....OOOO",
]);

// Mid-leap: stretched flat, claws forward, legs and tail trailing.
export const XENO_LEAP = frame(XENO, [
  "......OOOOO",
  "....OOgrbbxOOO",
  "...OxgrxxxXXXXOO..O.O.O",
  "..OxgxxxXXXXXXXXOOgOgOgOOO",
  "OWWxOOXXXXXXXXXXXXXXXXXXXXOOOO",
  "OOWWOxXXXXxgxXXXXXXXXXXXXXXXXXOOOO",
  ".OWOOXXXXxgxXXXXXXXXXXXOOXXXXXXXXbO",
  "OXXXOXXOOOXXXXXXXXXXOOO..OOOOOOOOO",
  "OOOOOXO..OXXXOOXXXXXXXO",
  ".....O....OOO..OOOXXXXXXO",
  "..................OOOXXXXXO",
  ".....................OOOOOO",
]);

// Down for good, curled on its side.
export const XENO_DEAD = frame(XENO, [
  "..........O.O.O",
  "....OOOOOOgOgOgOOOO",
  "..OOxgrbxXXXXXXXXXXOOO....OO",
  ".OWxxxXXXXXXXXxgxXXXXXOOOOXXO",
  "OWWOXXXXXXXXXXXXXXXXXXXXXXXO",
  "OOOXOXXOXXXOXXXXOOXXXOOOOOO",
  ".OOOOOOOOOOOOOOOOOOOOO",
]);

export const RIP_FRAMES = { stand: RIP_STAND, step: RIP_STEP, brace: RIP_BRACE };
export const XENO_FRAMES = {
  walkA: XENO_WALK_A, walkB: XENO_WALK_B, shriek: XENO_SHRIEK, leap: XENO_LEAP, dead: XENO_DEAD,
};
export type RipFrame = keyof typeof RIP_FRAMES;
export type XenoFrame = keyof typeof XENO_FRAMES;
