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
    T: "#c4c8cf", t: "#8e939c", u: "#dfe3ea",   // tank: mid / shadow / highlight
    K: "#857748", k: "#5c5230",
    R: "#3b3f4a", r: "#6e7482", i: "#9aa0ac", G: "#7fe07f",  // rifle + glint + ammo light
    B: "#3a2a1e", b: "#5a4632",                 // boots / scuff
  },
  rows: [
    "......OOOOOO....",
    ".....OHhhHHHO...",
    "....OHhhHHHHHO..",
    "..O.OHHHHHHHHHO.",
    ".OiO.OHSSSSSSHO.",
    ".OrO.OHSEWSSEWHO",
    ".OrO.OHSSSSSSSHO",
    ".OrO.OHHSsssSHHO",
    ".OrO..OHHSSSHHO.",
    ".OGO...OOSSSOO..",
    ".ORO..OuTSSSTtO.",
    ".ORO.OSuTTTTtTSO",
    ".OiO.OSTTtTTtTSO",
    ".OSSSSSTuTTTTTSO",
    ".OROOOOOTTTTTSO.",
    ".ORO...OTTTTTO..",
    ".ORRO..OKKkKKO..",
    ".OOOO..OKkKKKO..",
    ".......OKKOKkO..",
    ".......OkKOKKO..",
    ".......OkkOkkO..",
    "......OBbBOBbBO.",
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
    A: "#7a7f6a", a: "#565b4a", i: "#a2a794",   // armor: mid / shadow / specular
    d: "#20241a",                                // deep seam / muzzle
    K: "#5a6a3a", k: "#3e4a28",                  // camo / shadow (l reused for highlight)
    R: "#2f333c", r: "#5d6370", g: "#8a91a0",    // rifle: dark / hi / glint
    B: "#2a2418", b: "#463b26",                  // boots / scuff
  },
  rows: [
    ".....OOOOOO.....",
    "....OMllMMMMO...",
    "...OMllMMMMmMO..",
    "..OMMMlMMMMMMO..",
    "..OmOOOOOOOOmO..",
    "..OMOSSSSSSOMO..",
    "..OMOSEWSSEWOMO.",
    "...OOSSSSSSSOO..",
    "....OSsssssSO...",
    ".....OOSSSOO....",
    "...OOiAAAAAaOO..",
    "..OAOiYAdAAaOAO.",
    "..OAOAAAdAaaOAO.",
    "..OSOaAAdAAaOSO.",
    ".OSdRRgRRRRYRSO.",
    ".OOdgRRRRRRROOO.",
    "....OOKkKKlOO...",
    ".....OlKkKKO....",
    ".....OKkOlKO....",
    ".....OkKOKkO....",
    ".....OkkOkkO....",
    "....OBbBOBbBO...",
    "....OOOOOOOOO...",
    "................",
  ],
};

// Vasquez: red bandana, grey tank, harness, and the smartgun swung to her hip.
const vasquez: Body = {
  label: "VASQUEZ", gear: false,
  colors: {
    S: "#d9a577", s: "#b8804f", O: "#1a1212", E: "#1a1212",
    H: "#1e1a1a", D: "#d23a2a", d: "#8f2418", p: "#e8614a",  // bandana: red / shadow / highlight
    T: "#a8adb5", t: "#7c8088", u: "#d8dde3",   // tank: mid / shadow / highlight
    K: "#5a6a3a", k: "#3e4a28", l: "#6f8047",   // camo: mid / shadow / highlight
    R: "#2f333c", r: "#5d6370", i: "#9aa0ac",   // gun / hi / glint
    B: "#2a2418", b: "#463b26",
  },
  rows: [
    ".....OOOOOO.....",
    "....OHHHHHHO....",
    "...OpDdDDDDDO...",
    "..ODDpDDDDDDDO..",
    "..OHSSSSSSSSHO..",
    "..OHSEWSSSEWHO..",
    "..OHSSSSSSSSHO..",
    "...OSSsssssSO...",
    "....OSSSSSSO....",
    ".....OOSSOO.....",
    "...OOSuTTtSOO...",
    "..OSSORuTTOSSO..",
    "..OSSOTRTtOSSO..",
    "..OssOTTRTOssO..",
    "..OSSOTTTROSRiRO",
    "..OOOOTTTTRYRrrR",
    ".....OKkKKOOOOOO",
    ".....OKkKKO.....",
    "....OlKOOKkO....",
    "....OKkOOlKO....",
    "....OkkOOkkO....",
    "...OBbBOOBbBO...",
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
    C: "#a9b8c6", c: "#7e8c9a", D: "#c6d4e0", i: "#bfe3ff",  // shirt: mid / shadow / highlight / glow
    P: "#3c4656", p: "#2a3140", u: "#4e5a6e",   // trousers: mid / shadow / highlight
    B: "#22232a", b: "#34343e",
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
    "...ODCCWWCCcO...",
    "..ODCCCWWCCcCO..",
    "..OCcCCCWCCcCO..",
    "..OSOCCCWCCcOSO.",
    "..OiOOOCCCCcOOSO",
    "..OHO..OuPPpO.O.",
    "..OOO..OPPPpO...",
    ".......OuPPPO...",
    "......OPPOOppO..",
    "......OuPOOPPO..",
    "......OppOOppO..",
    ".....OBbBOOBbBO.",
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
    C: "#9a8c78", c: "#6e6250", D: "#b4a690",   // grubby shirt: mid / grime-shadow / highlight
    P: "#4a4a52", u: "#5e5e68", p: "#34343a",
    B: "#3a2a1e", b: "#4a3a2e",
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
    ".....ODCCCcO....",
    "....ODCCcCCcO...",
    "...OSDCcCCCcSO..",
    ".OWWWODCCCCcOSO.",
    ".OWEWOCCCCCcOO..",
    ".OWWWO.OCCCcO...",
    "..OOO..OuPPpO...",
    "......OuPOOPpO..",
    ".....OBbBOOBbBO.",
    ".....OOOOOOOOOO.",
  ],
};

// Jonesy: the Nostromo's orange tabby, sitting, tail around his paws.
const jonesy: Body = {
  label: "JONESY", gear: false,
  colors: {
    O: "#2a1608", E: "#1a0e04",
    F: "#e08a3c", f: "#b8621f", l: "#f0a860", C: "#f6e3c4", c: "#d8c09a",
    G: "#6fcf5a", N: "#e88b9a",
  },
  rows: [
    "................",
    "...OO......OO...",
    "..OlFO....OFfO..",
    "..OlNFO..OFNfO..",
    "..OlFfFOOFfFFO..",
    ".OllFFfFFfFFfFO.",
    ".OlFFFFFFFFFFfO.",
    ".OlEGFFFFFFEGfO.",
    ".OlFfFCCFFfFFfO.",
    ".OlFFFCNNCFFFfO.",
    "..OlFFCOOCFFfO..",
    "...OOlFFFFfOO...",
    "....OlFFFfO.....",
    "...OlFCCCCCcFO..",
    "..OlfFCCCCCCffO.",
    "..OlFFCCCCCCcFO.",
    "..OlfFFCCCCFcfO.",
    "..OlFFFCCCCFfFOO",
    "..OlfFFFFFFFfOfF",
    "..OlFFFFFFFFFOFF",
    "..OlFFFFFFFFFOfF",
    "..OlFOFFFFOFfOfF",
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
    J: "#b8a888", j: "#8c7e60", L: "#cabda0", P: "#c8402a",  // jacket: mid / shadow / highlight / patch
    z: "#9a9488",                                // zip / buckle metal
    k: "#7c6e52",
    B: "#3a2a1e", q: "#4a3a2e",                  // boots / scuff
  },
  rows: [
    ".....OOOOOO.....",
    "....OAaaAAAO....",
    "...OAAAaAAAAO...",
    "..ObbbbbbbbbbOO.",
    "...OHSSSSSSSHO..",
    "...OHSEWSSEWSO..",
    "...OSSSSSSSSSO..",
    "...OHHSsssSHHO..",
    "....OHHHHHHHO...",
    ".....OOHHHOO....",
    "...OLJJOSOJJJO..",
    "..OLJJJJzJJJJJO.",
    "..OJJJPJzjJJJJO.",
    "..OJJJJJzJJJJJO.",
    "..OSOJJJzJJJOSO.",
    "..OOOJJJzJJJOOO.",
    "....OJJJzJJJO...",
    ".....OkkzkkO....",
    ".....OkkOkkO....",
    ".....OkjOkkO....",
    ".....OkkOkkO....",
    "....OBqBOBqBO...",
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
    U: "#5a6070", u: "#3e4350", L: "#6c7284", D: "#8c2a2a",  // suit: mid / shadow / highlight / tie
    B: "#22232a", q: "#34343e",
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
    "...OLUUWWWUUYO..",
    "..OLUUUWDWUUUUO.",
    "..OUuUUWDWUUWUO.",
    "..OUuUUUDUUUUUO.",
    "..OSOUuUDUUUOSO.",
    "..OOOUUUUUUUOOO.",
    "....OUUUUUUUO...",
    ".....OuUuuuO....",
    ".....OuUOuuO....",
    ".....OuuOuUO....",
    ".....OuuOuuO....",
    "....OBqBOBqBO...",
    "....OOOOOOOOO...",
    "................",
  ],
};

// Dillon (and the rest of Fury 161): shaved head, prison-issue coveralls.
const dillon: Body = {
  label: "DILLON", gear: false,
  colors: {
    S: "#8c5a3c", s: "#6a4028", l: "#a8785a", O: "#1a1410", E: "#1a1410",
    V: "#7a6a52", v: "#5a4c3a", L: "#98876a",   // coveralls: mid / shadow / highlight
    z: "#8f8474",                                // zip
    B: "#2a2018", q: "#3e3020",
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
    "...OLVVOSOVVVO..",
    "..OLVvVVzVVvVVO.",
    "..OVvvVVzVVvvVO.",
    "..OVVVVVzVVVVVO.",
    "..OSOVVvzVVVOSO.",
    "..OOOVVvVVVVOOO.",
    "....OVVVzVVVO...",
    ".....OVvVVVO....",
    ".....OVVOVVO....",
    ".....OvvOvvO....",
    ".....OvvOvvO....",
    "....OBqBOBqBO...",
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
    G: "#a8d8f0", L: "#7fe0ff",                  // helmet glass / bright reflection
    U: "#5c6e8c", u: "#3e4c66", i: "#7e90ae",    // suit: mid / shadow / highlight
    z: "#cfe6f2",                                // ring bolts
    B: "#2a3140", q: "#3a4656",
  },
  rows: [
    ".....OOOOOO.....",
    "....OGGWGGLGO...",
    "...OGGHHHHHGGO..",
    "..OGGHHHHHHHGGO.",
    "..OGGHSSSSSHGGO.",
    "..OGGSEWSEWSGGO.",
    "..OGGSSSSSSSGGO.",
    "..OGGGSsssSGGGO.",
    "...OGGGSSSGGGO..",
    "...OLzLLLLLzLO..",
    "..OiUUUUUUUUUUO.",
    "..OUuUUUUUUUUUO.",
    "..OUOUUUUUUUOUO.",
    "..OUOUUUUUUUOUO.",
    "..OUOUUYLUUUOUO.",
    "..OOOUUUUUUUOOO.",
    "....OUUUUUUUO...",
    ".....OuUuuuO....",
    ".....OuuOuuO....",
    ".....OuuOuuO....",
    ".....OuuOuuO....",
    "....OBqBOBqBO...",
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
    b: "#9aa8c0",                                // wet biomech gloss
    W: "#e8ecf0",
  },
  rows: [
    "...........OOOO.",
    ".........OOxrbXO",
    ".......OOXxbgXXO",
    ".....OOXXbggXXO.",
    "...OOXXXbxgXXXO.",
    "..OXXXxXXXgXXO..",
    "..OXxXXXXXrXO...",
    "..OXxXXXXXXO....",
    "..OXWWWWWWWXO...",
    "..OXOWOWOWOXO.OO",
    "...OXgXXXgXO.OXO",
    ".....OXXXO...OgO",
    "..OOXxgXXXOO.OXO",
    ".OXOgxXXXXXOXOgO",
    ".OXOgxXXxXXOXOXO",
    ".OXOgXXxXXXOXOgO",
    ".OXOgxXXxXXOXOXO",
    ".OOOOXxgXXOOOOgO",
    ".....OXxXXXOOOXO",
    "....OXXOOXXO....",
    "....OgXO.OXgO...",
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
    b: "#9aa8c0",                                // wet biomech gloss
    W: "#e8ecf0",
  },
  rows: [
    ".OOO........OOO.",
    "OxrbOO....OObrXO",
    "OXxbgXOOOOXgbxXO",
    ".OXXbxggXXgxXXO.",
    "..OXXbggggbXXO..",
    "..OXxXXbbXXXXO..",
    "...OXXbXXbXXO...",
    "...OXXXXXXXXO...",
    "...OXWWWWWWXO...",
    "...OXOWOWOWXO...",
    "....OXgXXbXO....",
    "......OXXO......",
    "...OOXxgXXOO....",
    "..OXOgXXXXXOXO..",
    "..OXOgxXXxXOXO..",
    "..OXOgXXXXXOXO..",
    "..OOOgxXXxXOOO..",
    ".....OXgXXXO....",
    ".....OXxgXXO....",
    "....OXXOOXXO....",
    "....OgXO.OXgO...",
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
    ".........OFlFFFO",
    ".........OFOOOFO",
    ".........OFO.OfO",
    ".........OOO.OFO",
    ".............OfO",
    ".....OOOOO...OFO",
    "....OFlllFO..OfO",
    "...OFFlllFFO.OFO",
    "..OFFfFFFFfFFFFO",
    "..OFfFFFFFFfFFO.",
    "..OfFFFFFFFFffO.",
    "...OfffffffffO..",
    ".OFOFOfffffOFOFO",
    ".OFOFOOOOOOOFOFO",
    "OFOOFO....OFOOFO",
    "OfOOfO....OfOOfO",
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
    ".....OlClCCO....",
    "....OlCCCCcCO...",
    "....OlCCCCCcCO..",
    "....OCWWWWWCO...",
    ".....OCOOOCO....",
    ".....OlCCcO.....",
    "......OlCO......",
    ".....OlCcO......",
    "....OlccO.......",
    "...OlCCO........",
    "...OlCCOOOO.....",
    "..OlcCCCCCcOO...",
    "..OlCCCCcCCCCO..",
    ".OlCCOOOOOOOCCO.",
    ".OlCCO.....OCcO.",
    "..OlCCOOOOOOCcO.",
    "...OOOCCCCCcOO..",
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
