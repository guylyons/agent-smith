// The Alien cast, drawn as 16×24 pixel characters in the style of a 16-bit
// RPG: dark tinted outlines, two-tone shading lit from the upper left, big
// heads and small bodies. Each body brings its own color legend (see `colors`
// on Body in sprite-data.ts) — these are film characters, so a xenomorph is
// black and Ripley's tank top is grey on every palette. Row strings are 16
// cells; `.` is transparent, every other letter looks up a color, first in the
// body's own legend and then in the shared one in spriteRects (S/s skin,
// W white, E eye).
import type { Body } from "./sprite-data";

// Shared skin tones, so the humans read as one cast.
const SKIN = { S: "#f0c6a0", s: "#d49f79" };

// Ripley, Aliens: curly dark hair, grey tank top, khaki fatigues and the
// M41A pulse rifle held upright at her side.
const ripley: Body = {
  label: "RIPLEY", gear: false,
  colors: {
    ...SKIN, O: "#1c1410", E: "#1c1410",
    H: "#4a2c1a", h: "#7a4a2c",
    T: "#c4c8cf", t: "#8e939c",
    K: "#857748", k: "#5c5230",
    R: "#3b3f4a", r: "#6e7482", G: "#7fe07f",
    B: "#3a2a1e",
  },
  rows: [
    "......OOOOOO....",
    ".....OHhhHHHO...",
    "....OHhhHHHHHO..",
    "..O.OHHHHHHHHHO.",
    ".OrO.OHSSSSSSHO.",
    ".OrO.OHSEWSSEWHO",
    ".OrO.OHSSSSSSSHO",
    ".OrO.OHHSsssSHHO",
    ".OrO..OHHSSSHHO.",
    ".ORO...OOSSSOO..",
    ".OGO..OTTSSSTTO.",
    ".ORO.OSTTTTTTTSO",
    ".OSO.OSTTtTTtTSO",
    ".OSSSSSTTTTTTTSO",
    ".OROOOOOTTTTTSO.",
    ".ORO...OTTTTTO..",
    ".ORRO..OKKKKKO..",
    ".OOOO..OKKKKKO..",
    ".......OKKOKKO..",
    ".......OKKOKKO..",
    ".......OkkOkkO..",
    "......OBBBOBBBO.",
    "......OOOOOOOOO.",
    "................",
  ],
};

// A Colonial Marine (Hicks, Hudson, Apone…): M10 helmet, chest armor, camo
// trousers, pulse rifle held across the body.
const marine: Body = {
  label: "MARINE", gear: false,
  colors: {
    ...SKIN, O: "#12160f", E: "#12160f",
    M: "#6b7a3a", l: "#8c9a52", m: "#4a5528",
    A: "#7a7f6a", a: "#565b4a",
    K: "#5a6a3a", k: "#3e4a28",
    R: "#2f333c", r: "#5d6370",
    B: "#2a2418",
  },
  rows: [
    ".....OOOOOO.....",
    "....OMlMMMMO....",
    "...OMllMMMMMO...",
    "..OMMMMMMMMMMO..",
    "..OmOOOOOOOOmO..",
    "..OMOSSSSSSOMO..",
    "..OMOSEWSSEWOMO.",
    "...OOSSSSSSSOO..",
    "....OSsssssSO...",
    ".....OOSSSOO....",
    "...OOAAAAAAAOO..",
    "..OAOAlAAAAAOAO.",
    "..OAOAAAAAAAOAO.",
    "..OSOaAAAAAaOSO.",
    ".OSRRRRRRRRRRSO.",
    ".OORrrRRRRRROOO.",
    "....OOKKKKKOO...",
    ".....OKKKKKO....",
    ".....OKKOKKO....",
    ".....OKKOKKO....",
    ".....OkkOkkO....",
    "....OBBBOBBBO...",
    "....OOOOOOOOO...",
    "................",
  ],
};

// Vasquez: red bandana, grey tank, harness, and the smartgun swung to her hip.
const vasquez: Body = {
  label: "VASQUEZ", gear: false,
  colors: {
    S: "#d9a577", s: "#b8804f", O: "#1a1212", E: "#1a1212",
    H: "#1e1a1a", D: "#d23a2a", d: "#8f2418",
    T: "#a8adb5", t: "#7c8088",
    K: "#5a6a3a", k: "#3e4a28",
    R: "#2f333c", r: "#5d6370",
    B: "#2a2418",
  },
  rows: [
    ".....OOOOOO.....",
    "....OHHHHHHO....",
    "...ODDdDDDDDO...",
    "..ODDDDDDDDDDO..",
    "..OHSSSSSSSSHO..",
    "..OHSEWSSSEWHO..",
    "..OHSSSSSSSSHO..",
    "...OSSsssssSO...",
    "....OSSSSSSO....",
    ".....OOSSOO.....",
    "...OOSTTTTSOO...",
    "..OSSORTTTOSSO..",
    "..OSSOTRTTOSSO..",
    "..OssOTTRTOssO..",
    "..OSSOTTTROSRRRO",
    "..OOOOTTTTRRRrrR",
    ".....OKKKKOOOOOO",
    ".....OKKKKO.....",
    "....OKKOOKKO....",
    "....OKKOOKKO....",
    "....OkkOOkkO....",
    "...OBBBOOBBBO...",
    "...OOOOOOOOOO...",
    "................",
  ],
};

// Bishop (or Ash, David, Walter, Call…): a synthetic. Pale, tidy, a light
// crew shirt, and the knife from the knife trick held point down.
const bishop: Body = {
  label: "BISHOP", gear: false,
  colors: {
    S: "#f4dcc8", s: "#d8b8a0", O: "#1a1a20", E: "#1a1a20",
    H: "#2a2320", h: "#4a403a",
    C: "#a9b8c6", c: "#7e8c9a", i: "#bfe3ff",
    P: "#3c4656", p: "#2a3140",
    B: "#22232a",
  },
  rows: [
    ".....OOOOOO.....",
    "....OHhhHHHO....",
    "...OHhHHHHHHO...",
    "..OHHSSSSSSHHO..",
    "..OHSSSSSSSSHO..",
    "..OSSEiSSSEiSO..",
    "..OSSSSSSSSSSO..",
    "...OSSsssssSO...",
    "....OSSSSSSO....",
    ".....OOSSOO.....",
    "...OCCCWWCCCO...",
    "..OCCCCWWCCCCO..",
    "..OCcCCCWCCCCO..",
    "..OSOCCCWCCCOSO.",
    "..OWOOOCCCCCOOSO",
    "..OWO..OPPPPO.O.",
    "..OOO..OPPPPO...",
    ".......OPPPPO...",
    "......OPPOOPPO..",
    "......OPPOOPPO..",
    "......OppOOppO..",
    ".....OBBBOOBBBO.",
    ".....OOOOOOOOOO.",
    "................",
  ],
};

// Newt: a small girl in a grubby oversized shirt, blonde tangle of hair,
// holding Casey, the doll's head.
const newt: Body = {
  label: "NEWT", gear: false,
  colors: {
    ...SKIN, O: "#1c1610", E: "#1c1610",
    H: "#e0c060", h: "#f2dd90",
    C: "#9a8c78", c: "#6e6250",
    P: "#4a4a52",
    B: "#3a2a1e",
  },
  rows: [
    "................",
    "................",
    "................",
    "................",
    ".....OOOOOOO....",
    "....OhHHHhHHO...",
    "...OHhHHHHHHHO..",
    "...OHHSSSSSSHO..",
    "..OHHSSSSSSSHHO.",
    "..OHSSEWSSEWSHO.",
    "..OHSSSSSSSSSHO.",
    "..OHHSSsssSSHHO.",
    "...OHHSSSSSHHO..",
    "....OOOSSSOOO...",
    ".....OCCCCCO....",
    "....OCCCCCCCO...",
    "...OSCCcCCCCSO..",
    ".OWWWOCCCCCCOSO.",
    ".OWEWOCCCCCCOO..",
    ".OWWWO.OCCCCO...",
    "..OOO..OPPPPO...",
    "......OPPOOPPO..",
    ".....OBBBOOBBBO.",
    ".....OOOOOOOOOO.",
  ],
};

// Jonesy: the Nostromo's orange tabby, sitting, tail around his paws.
const jonesy: Body = {
  label: "JONESY", gear: false,
  colors: {
    O: "#2a1608", E: "#1a0e04",
    F: "#e08a3c", f: "#b8621f", C: "#f6e3c4",
    G: "#6fcf5a", N: "#e88b9a",
  },
  rows: [
    "................",
    "...OO......OO...",
    "..OFFO....OFFO..",
    "..OFNFO..OFNFO..",
    "..OFFFFOOFFFFO..",
    ".OFFfFFFFFFfFFO.",
    ".OFFFFFFFFFFFFO.",
    ".OFEGFFFFFFEGFO.",
    ".OFFFFFCCFFFFFO.",
    ".OFFfFCNNCFfFFO.",
    "..OFFFCOOCFFFO..",
    "...OOFFFFFFOO...",
    "....OFFFFFFO....",
    "...OFFCCCCCCFO..",
    "..OFfFCCCCCCFfO.",
    "..OFFFCCCCCCFFO.",
    "..OFfFFCCCCFFfO.",
    "..OFFFFCCCCFFFOO",
    "..OFfFFFFFFFfOFF",
    "..OFFFFFFFFFFOfF",
    "..OFFFFFFFFFFOFF",
    "..OFFOFFFFOFFOfF",
    "..OOOOOOOOOOOOOO",
    "................",
  ],
};

// Dallas (and the rest of the Nostromo's crew): ball cap, beard, padded
// tan flight jacket with a patch.
const dallas: Body = {
  label: "DALLAS", gear: false,
  colors: {
    ...SKIN, O: "#1a1410", E: "#1a1410",
    A: "#4a5a7a", a: "#6a7a9a", b: "#34425c",
    H: "#5a3a22",
    J: "#b8a888", j: "#8c7e60", P: "#c8402a",
    k: "#7c6e52",
    B: "#3a2a1e",
  },
  rows: [
    ".....OOOOOO.....",
    "....OAaaAAAO....",
    "...OAAAAAAAAO...",
    "..ObbbbbbbbbbOO.",
    "...OHSSSSSSSHO..",
    "...OHSEWSSEWSO..",
    "...OSSSSSSSSSO..",
    "...OHHSsssSHHO..",
    "....OHHHHHHHO...",
    ".....OOHHHOO....",
    "...OJJJOSOJJJO..",
    "..OJJJJJJJJJJJO.",
    "..OJJJPJJjJJJJO.",
    "..OJJJJJJJJJJJO.",
    "..OSOJJJjJJJOSO.",
    "..OOOJJJJJJJOOO.",
    "....OJJJJJJJO...",
    ".....OkkkkkO....",
    ".....OkkOkkO....",
    ".....OkkOkkO....",
    ".....OkkOkkO....",
    "....OBBBOBBBO...",
    "....OOOOOOOOO...",
    "................",
  ],
};

// Burke: the Company man. Slicked hair, grey suit, dark tie.
const burke: Body = {
  label: "BURKE", gear: false,
  colors: {
    ...SKIN, O: "#16151a", E: "#16151a",
    H: "#5c3a1e", h: "#7c5a3a",
    U: "#5a6070", u: "#3e4350", D: "#8c2a2a",
    B: "#22232a",
  },
  rows: [
    ".....OOOOOO.....",
    "....OHHhhHHO....",
    "...OHHHhHHHHO...",
    "..OHHHHHHHHHHO..",
    "..OHSSSSSSSSHO..",
    "..OSSEWSSSEWSO..",
    "..OSSSSSSSSSSO..",
    "...OSSsssssSO...",
    "....OSSSSSSO....",
    ".....OOSSOO.....",
    "...OUUUWWWUUUO..",
    "..OUUUUWDWUUUUO.",
    "..OUuUUWDWUUUUO.",
    "..OUUUUUDUUUUUO.",
    "..OSOUUUDUUUOSO.",
    "..OOOUUUUUUUOOO.",
    "....OUUUUUUUO...",
    ".....OuuuuuO....",
    ".....OuuOuuO....",
    ".....OuuOuuO....",
    ".....OuuOuuO....",
    "....OBBBOBBBO...",
    "....OOOOOOOOO...",
    "................",
  ],
};

// Dillon (and the rest of Fury 161): shaved head, prison-issue coveralls.
const dillon: Body = {
  label: "DILLON", gear: false,
  colors: {
    S: "#8c5a3c", s: "#6a4028", l: "#a8785a", O: "#1a1410", E: "#1a1410",
    V: "#7a6a52", v: "#5a4c3a",
    B: "#2a2018",
  },
  rows: [
    ".....OOOOOO.....",
    "....OSlSSSSO....",
    "...OSlSSSSSSO...",
    "..OSSSSSSSSSSO..",
    "..OSSSSSSSSSSO..",
    "..OSSEWSSSEWSO..",
    "..OSSSSSSSSSSO..",
    "...OSSsssssSO...",
    "....OSSSSSSO....",
    ".....OOSSOO.....",
    "...OVVVOSOVVVO..",
    "..OVVVVVVVVVVVO.",
    "..OVvVVVVVVVVVO.",
    "..OVVVVVVVVVVVO.",
    "..OSOVVVVVVVOSO.",
    "..OOOVVvVVVVOOO.",
    "....OVVVVVVVO...",
    ".....OVVVVVO....",
    ".....OVVOVVO....",
    ".....OvvOvvO....",
    ".....OvvOvvO....",
    "....OBBBOBBBO...",
    "....OOOOOOOOO...",
    "................",
  ],
};

// Shaw (Prometheus): the Weyland expedition suit with its lit bubble helmet.
const shaw: Body = {
  label: "SHAW", gear: false,
  colors: {
    ...SKIN, O: "#141a26", E: "#141a26",
    H: "#6a4a2a",
    G: "#a8d8f0", L: "#7fe0ff",
    U: "#5c6e8c", u: "#3e4c66",
    B: "#2a3140",
  },
  rows: [
    ".....OOOOOO.....",
    "....OGGWGGGGO...",
    "...OGGHHHHHGGO..",
    "..OGGHHHHHHHGGO.",
    "..OGGHSSSSSHGGO.",
    "..OGGSEWSEWSGGO.",
    "..OGGSSSSSSSGGO.",
    "..OGGGSsssSGGGO.",
    "...OGGGSSSGGGO..",
    "...OLLLLLLLLLO..",
    "..OUUUUUUUUUUUO.",
    "..OUuUUUUUUUUUO.",
    "..OUOUUUUUUUOUO.",
    "..OUOUUUUUUUOUO.",
    "..OUOUUuLUUUOUO.",
    "..OOOUUUUUUUOOO.",
    "....OUUUUUUUO...",
    ".....OuuuuuO....",
    ".....OuuOuuO....",
    ".....OuuOuuO....",
    ".....OuuOuuO....",
    "....OBBBOBBBO...",
    "....OOOOOOOOO...",
    "................",
  ],
};

// The xenomorph: long dome sweeping back, no eyes, a mouthful of silver
// teeth, ribbed body, tail curling up at its side.
const xenomorph: Body = {
  label: "XENOMORPH", gear: false,
  colors: {
    O: "#07080c",
    X: "#262b38", x: "#3d4456", g: "#5a6478", r: "#7d8aa3",
    W: "#e8ecf0",
  },
  rows: [
    "...........OOOO.",
    ".........OOxrgXO",
    ".......OOXxggXXO",
    ".....OOXXxggXXO.",
    "...OOXXXXxgXXXO.",
    "..OXXXXXXXXXXO..",
    "..OXxXXXXXXXO...",
    "..OXxXXXXXXO....",
    "..OXWWWWWWWXO...",
    "..OXOWOWOWOXO.OO",
    "...OXXXXXXXO.OXO",
    ".....OXXXO...OXO",
    "..OOXXxXXXOO.OXO",
    ".OXOXxXXXXXOXOXO",
    ".OXOXxXXxXXOXOXO",
    ".OXOXXXXXXXOXOXO",
    ".OXOXxXXxXXOXOXO",
    ".OOOOXXXXXOOOOXO",
    ".....OXxXXXOOOXO",
    "....OXXOOXXO....",
    "....OXXO.OXXO...",
    "...OXXXO.OXXXO..",
    "...OOOOO.OOOOO..",
    "................",
  ],
};

// The Queen: the same beast under a wide crest.
const queen: Body = {
  label: "QUEEN", gear: false,
  colors: {
    O: "#07080c",
    X: "#262b38", x: "#3d4456", g: "#5a6478", r: "#7d8aa3",
    W: "#e8ecf0",
  },
  rows: [
    ".OOO........OOO.",
    "OxrXOO....OOXrXO",
    "OXxXXXOOOOXXXxXO",
    ".OXXXXxggXXXXXO.",
    "..OXXXXggXXXXO..",
    "..OXxXXXXXXXXO..",
    "...OXXXXXXXXO...",
    "...OXXXXXXXXO...",
    "...OXWWWWWWXO...",
    "...OXOWOWOWXO...",
    "....OXXXXXXO....",
    "......OXXO......",
    "...OOXXxXXOO....",
    "..OXOXXXXXXOXO..",
    "..OXOXxXXxXOXO..",
    "..OXOXXXXXXOXO..",
    "..OOOXxXXxXOOO..",
    ".....OXXXXXO....",
    ".....OXXXXXO....",
    "....OXXOOXXO....",
    "....OXXO.OXXO...",
    "...OXXXO.OXXXO..",
    "...OOOOO.OOOOO..",
    "................",
  ],
};

// A facehugger: sac body, eight finger-legs, the long tail hooked up
// beside it.
const facehugger: Body = {
  label: "FACEHUGGER", gear: false,
  colors: {
    O: "#2e1e12",
    F: "#d8b898", f: "#b08c68", l: "#f0dcc0",
  },
  rows: [
    "................",
    "................",
    "................",
    "................",
    "..........OOOOO.",
    ".........OFFFFFO",
    ".........OFOOOFO",
    ".........OFO.OFO",
    ".........OOO.OFO",
    ".............OFO",
    ".....OOOOO...OFO",
    "....OFFlFFO..OFO",
    "...OFFFllFFO.OFO",
    "..OFFFFFFFFFFFFO",
    "..OFFFFFFFFFFFO.",
    "..OfFFFFFFFFffO.",
    "...OfffffffffO..",
    ".OFOFOfffffOFOFO",
    ".OFOFOOOOOOOFOFO",
    "OFOOFO....OFOOFO",
    "OFOOFO....OFOOFO",
    "OFOOFO....OFOOFO",
    "OOOOOO....OOOOOO",
    "................",
  ],
};

// A chestburster: the pale little serpent, rearing up out of its coils.
const chestburster: Body = {
  label: "CHESTBURSTER", gear: false,
  colors: {
    O: "#3a1a1a",
    C: "#e8b8a8", c: "#c08878", l: "#f8d8cc",
    W: "#f4f4f4",
  },
  rows: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "......OOOOO.....",
    ".....OCClCCO....",
    "....OCCCCCCCO...",
    "....OCCCCCCCCO..",
    "....OCWWWWWCO...",
    ".....OCOOOCO....",
    ".....OCCCCO.....",
    "......OCCO......",
    ".....OCCCO......",
    "....OCcCO.......",
    "...OCCCO........",
    "...OCCCOOOO.....",
    "..OCcCCCCCCOO...",
    "..OCCCCCcCCCCO..",
    ".OCCCOOOOOOOCCO.",
    ".OCCCO.....OCCO.",
    "..OCCCOOOOOOCCO.",
    "...OOOCCCCCCOO..",
    "......OOOOOO....",
  ],
};

/** The cast, in picker order: people first, then the things that hunt them. */
export const ALIEN_BODIES: Record<string, Body> = {
  ripley, marine, vasquez, bishop, newt, jonesy, dallas, burke, dillon, shaw,
  xenomorph, queen, facehugger, chestburster,
};

/** Which body each roster name (src/lib/crew.ts) wears by default. Marines
 *  share the marine, synthetics share Bishop, and the ships carry the
 *  creatures that came aboard them. A name missing here (a persona codename,
 *  or a name typed by hand) keeps the original worker. */
export const BODY_FOR_NAME: Record<string, string> = {
  // Alien
  RIPLEY: "ripley", DALLAS: "dallas", KANE: "dallas", LAMBERT: "dallas", PARKER: "dallas",
  BRETT: "dallas", ASH: "bishop", JONESY: "jonesy", NOSTROMO: "xenomorph",
  // Aliens
  HICKS: "marine", HUDSON: "marine", VASQUEZ: "vasquez", APONE: "marine", GORMAN: "marine",
  BISHOP: "bishop", BURKE: "burke", NEWT: "newt", DRAKE: "vasquez", FROST: "marine",
  FERRO: "marine", SPUNKMEYER: "marine", DIETRICH: "marine", WIERZBOWSKI: "marine",
  CROWE: "marine", SULACO: "queen",
  // Alien 3
  CLEMENS: "shaw", DILLON: "dillon", ANDREWS: "burke", GOLIC: "dillon", MORSE: "dillon", AARON: "burke",
  // Alien Resurrection
  CALL: "bishop", VRIESS: "dallas", JOHNER: "dallas", CHRISTIE: "dallas", ELGYN: "dallas",
  HILLARD: "dallas", WREN: "shaw", GEDIMAN: "shaw", DISTEPHANO: "marine", AURIGA: "chestburster",
  // Prometheus
  SHAW: "shaw", HOLLOWAY: "shaw", DAVID: "bishop", VICKERS: "burke", JANEK: "dallas",
  FIFIELD: "shaw", MILLBURN: "shaw", CHANCE: "dallas", RAVEL: "dallas",
  // Alien: Covenant
  DANIELS: "dallas", ORAM: "dallas", TENNESSEE: "dallas", WALTER: "bishop", LOPE: "marine",
  KARINE: "shaw", FARIS: "dallas", ANKOR: "marine", LEDWARD: "shaw", HALLETT: "marine",
  COLE: "marine", ROSENTHAL: "marine", COVENANT: "facehugger",
  // Alien: Romulus
  RAIN: "ripley", ANDY: "bishop", TYLER: "dallas", KAY: "dallas", BJORN: "dallas",
  NAVARRO: "dallas", ROOK: "bishop", CORBELAN: "xenomorph",
  // Alien: Earth
  WENDY: "bishop", KIRSH: "bishop", HERMIT: "shaw", SLIGHTLY: "bishop", NIBS: "bishop",
  CURLY: "bishop", SMEE: "bishop", MORROW: "marine", KAVALIER: "burke", MAGINOT: "facehugger",
};

/** The body a display name wears by default. Names arrive uppercase from the
 *  roster but may carry a uniquifier ("RIPLEY 3f2a") or be typed by hand in
 *  any case, so match on the first word, case-insensitively. */
export function bodyForName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const first = name.trim().split(/\s+/)[0]?.toUpperCase();
  return first ? BODY_FOR_NAME[first] : undefined;
}
