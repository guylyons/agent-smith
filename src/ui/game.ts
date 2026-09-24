// The GAME view's rules: which room of the Nostromo map an agent stands in,
// where in that room, and the corridor path it walks to get somewhere else.
// Pure and DOM-free, so it can be unit-tested; GameView.tsx only draws it.
//
// Every coordinate is in the map image's own pixels (nostromo.png, 1536x1024).
import type { AgentStatus } from "../schema";
import type { Assignee, Board } from "../lib/board";
import { columnStage } from "../lib/board";

export const MAP_W = 1536;
export const MAP_H = 1024;

export type Pt = { x: number; y: number };
export type RoomId =
  | "bridge" | "computer" | "workshop" | "comms" | "medbay"
  | "mess" | "hypersleep" | "cargo" | "airlock";

type Room = {
  label: string;
  /** The room's floor, measured from the art. */
  rect: { x: number; y: number; w: number; h: number };
  /** Where sprites stand (their feet), in fill order. */
  spots: Pt[];
  /** Just inside the room's doorway. */
  door: Pt;
  /** By spot index: a point walked through between the door and that spot,
   *  where a straight line would cross furniture. */
  via?: Record<number, Pt>;
  /** The corridor point outside that doorway. */
  exit: Pt;
};

// The two long corridors run left-right across the ship; the trunk runs
// down the middle and joins them.
const UPPER = 312;
const LOWER = 638;
const TRUNK = 768;

export const ROOMS: Record<RoomId, Room> = {
  computer: {
    label: "COMPUTER ROOM",
    rect: { x: 95, y: 70, w: 360, h: 205 },
    spots: [{ x: 200, y: 262 }, { x: 290, y: 262 }, { x: 380, y: 262 }, { x: 150, y: 190 }, { x: 410, y: 190 }, { x: 240, y: 135 }],
    // Round the central desk.
    via: { 3: { x: 190, y: 250 }, 4: { x: 400, y: 250 }, 5: { x: 190, y: 250 } },
    door: { x: 320, y: 262 },
    exit: { x: 320, y: UPPER },
  },
  bridge: {
    label: "BRIDGE",
    rect: { x: 560, y: 150, w: 420, h: 120 },
    spots: [{ x: 768, y: 200 }, { x: 700, y: 258 }, { x: 836, y: 258 }, { x: 600, y: 190 }, { x: 936, y: 190 }, { x: 768, y: 250 }],
    // Round the two console banks.
    via: { 3: { x: 600, y: 258 }, 4: { x: 936, y: 258 } },
    door: { x: TRUNK, y: 262 },
    exit: { x: TRUNK, y: UPPER },
  },
  comms: {
    label: "COMMS",
    rect: { x: 1085, y: 110, w: 360, h: 165 },
    spots: [{ x: 1150, y: 262 }, { x: 1240, y: 262 }, { x: 1330, y: 262 }, { x: 1120, y: 190 }, { x: 1250, y: 200 }, { x: 1385, y: 262 }],
    door: { x: 1215, y: 262 },
    exit: { x: 1215, y: UPPER },
  },
  workshop: {
    label: "WORKSHOP",
    rect: { x: 90, y: 395, w: 420, h: 185 },
    spots: [{ x: 200, y: 460 }, { x: 420, y: 470 }, { x: 215, y: 560 }, { x: 195, y: 515 }, { x: 420, y: 560 }, { x: 230, y: 420 }],
    // Round the central bench.
    via: { 2: { x: 205, y: 460 }, 3: { x: 205, y: 460 }, 4: { x: 410, y: 470 } },
    // Below the red cabinet beside the doorway, so walks to the left clear it.
    door: { x: 320, y: 424 },
    exit: { x: 320, y: UPPER },
  },
  medbay: {
    label: "MEDBAY",
    // The doorway is in the bottom wall, onto the lower corridor.
    rect: { x: 1050, y: 420, w: 360, h: 160 },
    spots: [{ x: 1110, y: 480 }, { x: 1330, y: 480 }, { x: 1215, y: 560 }, { x: 1110, y: 560 }, { x: 1330, y: 560 }, { x: 1370, y: 490 }],
    // Round the centre table.
    via: { 0: { x: 1110, y: 560 }, 1: { x: 1330, y: 560 }, 5: { x: 1330, y: 560 } },
    door: { x: 1215, y: 588 },
    exit: { x: 1215, y: LOWER },
  },
  mess: {
    label: "MESS HALL",
    // Entered at the top right, where the trunk comes down past the counter.
    rect: { x: 530, y: 740, w: 260, h: 170 },
    spots: [{ x: 745, y: 760 }, { x: 705, y: 760 }, { x: 780, y: 805 }, { x: 545, y: 780 }, { x: 545, y: 850 }, { x: 720, y: 895 }],
    // Left spots along the aisle under the counter; the bottom one round the small table.
    via: { 3: { x: 548, y: 746 }, 4: { x: 548, y: 746 }, 5: { x: 785, y: 890 } },
    // At the foot of the entrance, level with the aisle under the counter.
    door: { x: TRUNK, y: 742 },
    exit: { x: TRUNK, y: LOWER },
  },
  hypersleep: {
    label: "HYPERSLEEP",
    // Five pods, left to right; a sleeper lies in one. The art has no doorway
    // of its own: it opens off the mess's entrance, under the trunk.
    rect: { x: 805, y: 700, w: 200, h: 210 },
    spots: [{ x: 830, y: 820 }, { x: 868, y: 820 }, { x: 906, y: 820 }, { x: 944, y: 820 }, { x: 982, y: 820 }],
    door: { x: 785, y: 742 },
    exit: { x: TRUNK, y: LOWER },
  },
  cargo: {
    label: "CARGO",
    // Label-only: it carries the "N DONE" count, and nobody is sent here.
    rect: { x: 80, y: 690, w: 360, h: 220 },
    spots: [],
    door: { x: 320, y: 690 },
    exit: { x: 320, y: LOWER },
  },
  airlock: {
    label: "AIRLOCK",
    rect: { x: 1180, y: 700, w: 200, h: 200 },
    spots: [{ x: 1265, y: 820 }, { x: 1225, y: 860 }, { x: 1305, y: 860 }, { x: 1225, y: 780 }, { x: 1305, y: 780 }],
    door: { x: 1215, y: 690 },
    exit: { x: 1215, y: LOWER },
  },
};

export const ROOM_IDS = Object.keys(ROOMS) as RoomId[];

/** A persona id, or failing that the role turned into one ("Frontend UX" ->
 *  "frontend-ux"), so a hand-started desk with a matching role still counts. */
function personaOf(a: Pick<AgentStatus, "persona" | "role">): string {
  if (a.persona) return a.persona;
  return (a.role ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-");
}

/** Board cards this agent holds: by session id, or by crew id (a card follows
 *  its agent across a /clear). */
function cardsOf(board: Board, a: Pick<AgentStatus, "sessionId" | "crew">) {
  const crew = a.crew?.id;
  return board.cards.filter((c) => c.assignee && (c.assignee.id === a.sessionId || (!!crew && c.assignee.crew === crew)));
}

function stageOf(board: Board, columnId: string) {
  const col = board.columns.find((c) => c.id === columnId);
  return col ? columnStage(col) : undefined;
}

/** Where each persona works while it is busy. Every persona in personas/*.md
 *  needs an entry here (a test checks), except the scrum master, who is always
 *  on the bridge. A persona missing from this table works in the workshop. */
export const PERSONA_ROOM: Record<string, RoomId> = {
  "frontend-ux": "computer",
  editor: "comms",
  "release-manager": "comms",
  "backend-dev": "workshop",
};

/** The room an agent belongs in right now. Order matters: someone waiting on
 *  you is on the bridge whatever their job, and so is the scrum master; a
 *  working agent is in its persona's room, even if an older card of theirs is
 *  still in review; an idle agent with a card in review sits in the medbay;
 *  any other idle agent is in the mess. */
export function roomFor(a: Pick<AgentStatus, "sessionId" | "state" | "persona" | "role" | "crew">, board: Board): RoomId {
  const persona = personaOf(a);
  if (a.state === "waiting" || persona === "scrum-master") return "bridge";
  if (a.state === "working") return Object.hasOwn(PERSONA_ROOM, persona) ? PERSONA_ROOM[persona]! : "workshop";
  if (cardsOf(board, a).some((c) => stageOf(board, c.columnId) === "review")) return "medbay";
  return "mess";
}

/** Where the i-th agent in a room stands. Past the last marked spot, agents
 *  fan out around them so they never land exactly on top of each other. */
export function spotFor(room: RoomId, i: number): Pt {
  const spots = ROOMS[room].spots;
  const base = spots[i % spots.length]!;
  const lap = Math.floor(i / spots.length);
  if (!lap) return base;
  // Each extra lap steps a little further right and down, alternating sides.
  const side = lap % 2 ? 1 : -1;
  return { x: base.x + side * 18 * Math.ceil(lap / 2), y: base.y + 10 * Math.ceil(lap / 2) };
}

export type Placement = { room: RoomId; slot: number; at: Pt };

/** Every agent's room and spot. Someone who stays in the same room keeps the
 *  spot they had in `prev`, so an arrival never shuffles the people already
 *  there; everyone else takes the lowest free spot, in session-id order, so a
 *  snapshot that reorders the list moves nobody either. */
export function placeAll(agents: AgentStatus[], board: Board, prev?: Map<string, Placement>): Map<string, Placement> {
  const byRoom = new Map<RoomId, string[]>();
  for (const a of agents) {
    const r = roomFor(a, board);
    byRoom.set(r, [...(byRoom.get(r) ?? []), a.sessionId]);
  }
  const out = new Map<string, Placement>();
  for (const [room, ids] of byRoom) {
    ids.sort();
    const taken = new Set<number>();
    const fresh: string[] = [];
    for (const id of ids) {
      const was = prev?.get(id);
      if (was && was.room === room && !taken.has(was.slot)) { taken.add(was.slot); out.set(id, was); }
      else fresh.push(id);
    }
    let slot = 0;
    for (const id of fresh) {
      while (taken.has(slot)) slot++;
      taken.add(slot);
      out.set(id, { room, slot, at: spotFor(room, slot) });
    }
  }
  return out;
}

/** The in-room waypoint for a point in a room: that of the marked spot it is
 *  nearest, so an agent fanned out past the last spot uses its base spot's. */
export function viaFor(room: RoomId, at: Pt): Pt | undefined {
  const { spots, via } = ROOMS[room];
  if (!via || !spots.length) return undefined;
  let best = 0;
  for (let i = 1; i < spots.length; i++) {
    if (Math.hypot(spots[i]!.x - at.x, spots[i]!.y - at.y) < Math.hypot(spots[best]!.x - at.x, spots[best]!.y - at.y)) best = i;
  }
  return via[best];
}

/** The waypoints from a spot in one room to a spot in another: out through the
 *  door, along the corridors (via the trunk if they're on different ones), in
 *  through the other door. Within one room it is a straight step. */
export function pathBetween(from: RoomId, fromAt: Pt, to: RoomId, toAt: Pt): Pt[] {
  if (from === to) return [fromAt, toAt];
  const a = ROOMS[from], b = ROOMS[to];
  const va = viaFor(from, fromAt), vb = viaFor(to, toAt);
  const pts: Pt[] = [fromAt, ...(va ? [va] : []), a.door, a.exit];
  if (a.exit.y !== b.exit.y) pts.push({ x: TRUNK, y: a.exit.y }, { x: TRUNK, y: b.exit.y });
  pts.push(b.exit, b.door, ...(vb ? [vb] : []), toAt);
  // Drop repeats (a door that is also the spot, a room whose exit is the trunk).
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);
}

export type OverlayLine = { a: Pt; b: Pt; kind: "corridor" | "exit" | "leg" };
export type Overlay = {
  rooms: { id: RoomId; rect: Room["rect"]; spots: Pt[]; door: Pt; exit: Pt; vias: Pt[] }[];
  lines: OverlayLine[];
};

/** What the ROOMS debug overlay (#game?rooms=1) draws, in map pixels: every
 *  room's rect, spots, door, exit and in-room waypoints, the door-exit legs,
 *  the last leg of the walk to each spot, and the corridor lines. */
export function roomsOverlay(): Overlay {
  const rooms = ROOM_IDS.map((id) => {
    const { rect, spots, door, exit, via } = ROOMS[id];
    return { id, rect, spots, door, exit, vias: Object.values(via ?? {}) };
  });
  // Each corridor is drawn as far as walks use it: its outermost exits, and
  // the trunk.
  const span = (y: number) => {
    const xs = [TRUNK, ...rooms.filter((r) => r.exit.y === y).map((r) => r.exit.x)];
    return { a: { x: Math.min(...xs), y }, b: { x: Math.max(...xs), y }, kind: "corridor" as const };
  };
  const lines: OverlayLine[] = [span(UPPER), span(LOWER), { a: { x: TRUNK, y: UPPER }, b: { x: TRUNK, y: LOWER }, kind: "corridor" }];
  for (const r of rooms) {
    lines.push({ a: r.door, b: r.exit, kind: "exit" });
    for (const p of r.spots) {
      const v = viaFor(r.id, p);
      if (v) lines.push({ a: r.door, b: v, kind: "leg" }, { a: v, b: p, kind: "leg" });
      else lines.push({ a: r.door, b: p, kind: "leg" });
    }
  }
  return { rooms, lines };
}

export function pathLength(path: Pt[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  return d;
}

/** The point `dist` along a path, clamped to its ends. */
export function pointAlong(path: Pt[], dist: number): Pt {
  if (!path.length) return { x: 0, y: 0 };
  let left = Math.max(0, dist);
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!, q = path[i]!;
    const seg = Math.hypot(q.x - p.x, q.y - p.y);
    if (left <= seg) {
      const t = seg ? left / seg : 1;
      return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    }
    left -= seg;
  }
  return path[path.length - 1]!;
}

export type Sleeper = { who: Assignee; cardId: string };

/** People still named on an open card whose session has ended: the board
 *  remembers them, the fleet doesn't. Cards in a done column, or a column past
 *  it (Merged, Archived), are finished and don't count. One entry per person,
 *  with the first open card they hold (what clicking them opens). */
export function sleepers(board: Board, agents: Pick<AgentStatus, "sessionId" | "crew">[]): Sleeper[] {
  const liveIds = new Set(agents.map((a) => a.sessionId));
  const liveCrew = new Set(agents.map((a) => a.crew?.id).filter(Boolean));
  const seen = new Set<string>();
  const out: Sleeper[] = [];
  for (const c of board.cards) {
    const who = c.assignee;
    if (!who || finished(board, c.columnId)) continue;
    if (liveIds.has(who.id) || (who.crew && liveCrew.has(who.crew))) continue;
    const key = who.crew ?? who.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ who, cardId: c.id });
  }
  return out;
}

/** Is this column done, or after the done column (a Merged or Archive)? */
function finished(board: Board, columnId: string): boolean {
  const done = board.columns.findIndex((c) => columnStage(c) === "done");
  const at = board.columns.findIndex((c) => c.id === columnId);
  return done >= 0 && at >= done;
}

/** How many cards are finished: in the done column or any column past it. */
export function cargoCount(board: Board): number {
  return board.cards.filter((c) => finished(board, c.columnId)).length;
}
