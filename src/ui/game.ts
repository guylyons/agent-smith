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
    spots: [{ x: 200, y: 460 }, { x: 420, y: 470 }, { x: 235, y: 560 }, { x: 195, y: 515 }, { x: 420, y: 560 }, { x: 240, y: 420 }],
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

// A sprite is drawn 2.6% of the map wide and half as tall again, standing on
// its spot.
const SPRITE_W = 40;
const SPRITE_H = 60;

/** Everywhere in a room an agent can stand: the marked spots, then a grid
 *  over the rest of the floor, front row first. A grid place is left out if a
 *  sprite on it would cover one on a place already listed. */
function places({ rect, spots }: Room): Pt[] {
  const out = [...spots];
  for (let y = rect.y + rect.h; y >= rect.y + SPRITE_H / 2; y -= SPRITE_H) {
    for (let x = rect.x + SPRITE_W / 2; x <= rect.x + rect.w - SPRITE_W / 2; x += SPRITE_W) {
      if (out.every((p) => Math.abs(p.x - x) >= SPRITE_W || Math.abs(p.y - y) >= SPRITE_H)) out.push({ x, y });
    }
  }
  return out;
}

const PLACES = Object.fromEntries(ROOM_IDS.map((id) => [id, places(ROOMS[id])])) as Record<RoomId, Pt[]>;

/** Where the i-th agent in a room stands: a marked spot, then the grid.
 *  Undefined once the room is full. */
export function spotFor(room: RoomId, i: number): Pt | undefined {
  return PLACES[room][i];
}

/** How many agents a room has places for. */
export const roomSize = (room: RoomId) => PLACES[room].length;

/** `over`: the room is full. The agent waits at its door (`at`) and is listed
 *  under the room's "+N" instead of drawn. */
export type Placement = { room: RoomId; slot: number; at: Pt; over?: true };

/** An agent's identity on the map: its crew id when it has one, so a /clear
 *  (new session id, same crew member) doesn't look like a new arrival. */
export const agentKey = (a: Pick<AgentStatus, "sessionId" | "crew">) => a.crew?.id ?? a.sessionId;

/** Every agent's room and spot, keyed by agentKey. Someone who stays in the
 *  same room keeps the spot they had in `prev`, so an arrival never shuffles
 *  the people already there; everyone else takes the lowest free spot, in key
 *  order, so a snapshot that reorders the list moves nobody either. Past the
 *  room's last place they are `over`, until a spot comes free. */
export function placeAll(agents: AgentStatus[], board: Board, prev?: Map<string, Placement>): Map<string, Placement> {
  const byRoom = new Map<RoomId, string[]>();
  for (const a of agents) {
    const r = roomFor(a, board);
    byRoom.set(r, [...(byRoom.get(r) ?? []), agentKey(a)]);
  }
  const out = new Map<string, Placement>();
  for (const [room, ids] of byRoom) {
    ids.sort();
    const taken = new Set<number>();
    const fresh: string[] = [];
    for (const id of ids) {
      const was = prev?.get(id);
      if (was && was.room === room && !was.over && !taken.has(was.slot)) { taken.add(was.slot); out.set(id, was); }
      else fresh.push(id);
    }
    let slot = 0;
    for (const id of fresh) {
      while (taken.has(slot)) slot++;
      taken.add(slot);
      const at = spotFor(room, slot);
      out.set(id, at ? { room, slot, at } : { room, slot, at: ROOMS[room].door, over: true });
    }
  }
  return out;
}

/** The in-room waypoint for a point in a room: that of the marked spot it is
 *  nearest, so an agent on the grid uses its nearest spot's. None for the
 *  door itself. */
export function viaFor(room: RoomId, at: Pt): Pt | undefined {
  const { spots, via, door } = ROOMS[room];
  if (!via || !spots.length || (at.x === door.x && at.y === door.y)) return undefined;
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
  const pts: Pt[] = [fromAt, ...(va ? [va] : []), a.door];
  // Rooms off the same corridor point (the mess and hypersleep) go door to door.
  if (a.exit.x !== b.exit.x || a.exit.y !== b.exit.y) {
    pts.push(a.exit);
    if (a.exit.y !== b.exit.y) pts.push({ x: TRUNK, y: a.exit.y }, { x: TRUNK, y: b.exit.y });
    pts.push(b.exit);
  }
  pts.push(b.door, ...(vb ? [vb] : []), toAt);
  // Drop repeats (a door that is also the spot, a room whose exit is the trunk).
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);
}

export type OverlayLine = { a: Pt; b: Pt; kind: "corridor" | "exit" | "leg" };
export type Overlay = {
  rooms: { id: RoomId; rect: Room["rect"]; spots: Pt[]; grid: Pt[]; door: Pt; exit: Pt; vias: Pt[] }[];
  lines: OverlayLine[];
};

/** What the ROOMS debug overlay (#game?rooms=1) draws, in map pixels: every
 *  room's rect, spots, grid places, door, exit and in-room waypoints, the
 *  door-exit legs, the last leg of the walk to each spot, and the corridor
 *  lines. */
export function roomsOverlay(): Overlay {
  const rooms = ROOM_IDS.map((id) => {
    const { rect, spots, door, exit, via } = ROOMS[id];
    return { id, rect, spots, grid: PLACES[id].slice(spots.length), door, exit, vias: Object.values(via ?? {}) };
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

// Walking speed, in map pixels per second: a cross-ship trip takes a few seconds.
export const SPEED = 260;

/** A walk: the path from where someone was to where they are going, begun at
 *  `start` (a performance.now() time). A walk that has arrived just stays at
 *  its end. `room` is where it ends: a live agent's room, "hypersleep" for a
 *  sleeper (ended session, still on an open card) or "airlock" for someone on
 *  the way out, who is gone once they get there. */
export type Walk = { room: RoomId; to: Pt; path: Pt[]; len: number; start: number };

/** Everyone's walks after a snapshot, keyed by agentKey. An agent whose
 *  placement is unchanged keeps its walk as it was. A change of room or spot
 *  starts a new walk from wherever it stands at `now`. A newcomer walks in
 *  from the airlock, unless nothing is `primed` yet (the first snapshot:
 *  everyone on it was already aboard) when it simply appears. An agent with no
 *  placement is skipped.
 *
 *  Departures mirror arrivals. Someone gone from the list who is in `asleep`
 *  walks to the lowest free hypersleep pod and keeps that pod while they
 *  sleep; a sleeper never seen awake simply lies in one. Anyone else gone
 *  from the list (and a sleeper when every pod is taken) walks out to the
 *  airlock and is dropped once there. Because a sleeper's walk stays in the
 *  map, a session that comes back under the same key walks from its pod to
 *  its room like any other move.
 *
 *  With `reduceMotion` every walk is a jump and leavers just go. `prev` is
 *  not changed. */
export function stepWalks(
  prev: Map<string, Walk>, agents: AgentStatus[], placements: Map<string, Placement>, now: number,
  { reduceMotion, primed, asleep = [] }: { reduceMotion: boolean; primed: boolean; asleep?: Sleeper[] },
): Map<string, Walk> {
  const out = new Map<string, Walk>();
  const here = (w: Walk) => pointAlong(w.path, (now - w.start) * SPEED / 1000);
  const walk = (room: RoomId, to: Pt, path: Pt[]): Walk => ({ room, to, path, len: pathLength(path), start: now });
  for (const a of agents) {
    const k = agentKey(a);
    const p = placements.get(k);
    if (!p) continue;
    const w = prev.get(k);
    if (w && w.room === p.room && w.to.x === p.at.x && w.to.y === p.at.y) { out.set(k, w); continue; }
    let path: Pt[];
    if (reduceMotion) path = [p.at];
    else if (w) path = pathBetween(w.room, here(w), p.room, p.at);
    else if (primed) path = pathBetween("airlock", ROOMS.airlock.spots[0]!, p.room, p.at);
    else path = [p.at];
    out.set(k, walk(p.room, p.at, path));
  }

  // Sleepers already in a pod keep it; the rest take the lowest free one.
  const pods = ROOMS.hypersleep.spots;
  const taken = new Set<number>();
  const fresh: string[] = [];
  for (const k of asleep.map(sleeperKey)) {
    if (out.has(k)) continue;
    const w = prev.get(k);
    const pod = w?.room === "hypersleep" ? pods.findIndex((p) => p.x === w.to.x && p.y === w.to.y) : -1;
    if (pod >= 0 && !taken.has(pod)) { taken.add(pod); out.set(k, w!); }
    else fresh.push(k);
  }
  for (const k of fresh) {
    const pod = pods.findIndex((_, i) => !taken.has(i));
    if (pod < 0) break;
    taken.add(pod);
    const w = prev.get(k), to = pods[pod]!;
    out.set(k, walk("hypersleep", to, w && !reduceMotion ? pathBetween(w.room, here(w), "hypersleep", to) : [to]));
  }

  // Everyone else who was on the map heads for the airlock.
  if (!reduceMotion) for (const [k, w] of prev) {
    if (out.has(k)) continue;
    if (w.room !== "airlock") {
      const to = ROOMS.airlock.spots[0]!;
      out.set(k, walk("airlock", to, pathBetween(w.room, here(w), "airlock", to)));
    } else if ((now - w.start) * SPEED / 1000 < w.len) out.set(k, w);
  }
  return out;
}

/** Where each walk has got to at `now`, and whether anyone is still moving
 *  (so the view knows to keep ticking frames). Someone who has reached the
 *  airlock on their way out is left off: they are gone. */
export function walkersAt(walks: Map<string, Walk>, now: number): { at: Map<string, Pt>; moving: boolean } {
  const at = new Map<string, Pt>();
  let moving = false;
  for (const [k, w] of walks) {
    const d = (now - w.start) * SPEED / 1000;
    if (d < w.len) moving = true;
    else if (w.room === "airlock") continue;
    at.set(k, pointAlong(w.path, d));
  }
  return { at, moving };
}

export type Sleeper = { who: Assignee; cardId: string };

/** A sleeper's key on the map: the same one agentKey gave them awake. */
export const sleeperKey = (s: Sleeper) => s.who.crew ?? s.who.id;

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

const TAB_RANK: Record<AgentStatus["state"], number> = { waiting: 0, working: 1, idle: 2 };

/** The order the map's agents are rendered in, which is their Tab order:
 *  whoever is waiting on you first, then working, then idle, each group in
 *  snapshot order. Sleepers come after all of them. Drawing order is by
 *  zIndex, so this changes only the keyboard and screen-reader order. */
export function tabOrder<T extends Pick<AgentStatus, "state">>(agents: T[]): T[] {
  return [...agents].sort((a, b) => TAB_RANK[a.state] - TAB_RANK[b.state]);
}

/** A full room's "+N": the agents it has no place for, most urgent first.
 *  `state` is that of the most urgent, so tabOrder puts the button just after
 *  the agents in that state. */
export type Crowd<T> = { room: RoomId; state: AgentStatus["state"]; who: T[] };

export function crowds<T extends Pick<AgentStatus, "sessionId" | "crew" | "state">>(agents: T[], placed: Map<string, Placement>): Crowd<T>[] {
  const out: Crowd<T>[] = [];
  for (const a of tabOrder(agents)) {
    const p = placed.get(agentKey(a));
    if (!p?.over) continue;
    const c = out.find((c) => c.room === p.room);
    if (c) c.who.push(a);
    else out.push({ room: p.room, state: a.state, who: [a] });
  }
  return out;
}

type Size = { w: number; h: number };

/** Where to scroll a map drawn at `map` size inside a `view`-sized box so
 *  `at` (in art pixels) is centred, clamped to the map's edges. With no point
 *  it centres the map. An axis the map already fits on stays at 0. */
export function scrollToShow(at: Pt | undefined, map: Size, view: Size): { left: number; top: number } {
  const p = at ?? { x: MAP_W / 2, y: MAP_H / 2 };
  const axis = (v: number, art: number, drawn: number, seen: number) =>
    Math.round(Math.max(0, Math.min(drawn - seen, (v / art) * drawn - seen / 2)));
  return { left: axis(p.x, MAP_W, map.w, view.w), top: axis(p.y, MAP_H, map.h, view.h) };
}

/** How far to slide a tag sideways so it sits inside the visible box with
 *  `pad` px to spare: 0 when it already fits. A tag wider than the box keeps
 *  its left edge in view. */
export function nudgeInto(tag: { left: number; right: number }, box: { left: number; right: number }, pad = 4): number {
  const min = box.left + pad, max = box.right - pad;
  if (tag.left < min) return min - tag.left;
  if (tag.right > max) return Math.max(max - tag.right, min - tag.left);
  return 0;
}
