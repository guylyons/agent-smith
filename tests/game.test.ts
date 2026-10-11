// tests/game.test.ts — the GAME view's rules: which room an agent stands in,
// where, and the corridor path between rooms. Drawing it was checked in the
// browser.
import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { roomFor, PERSONA_ROOM, spotFor, placeAll, stepWalks, walkersAt, agentKey, pathBetween, pathLength, pointAlong, sleepers, cargoCount, viaFor, roomsOverlay, tabOrder, crowds, roomSize, scrollToShow, nudgeInto, ROOMS, ROOM_IDS, MAP_W, MAP_H } from "../src/ui/game";
import { viewFromHash, hashForView, hashFlag } from "../src/ui/view";
import type { AgentStatus } from "../src/schema";
import type { Board } from "../src/lib/board";

const board: Board = {
  columns: [
    { id: "backlog", name: "Backlog", instruction: "" },
    { id: "in-progress", name: "In progress", instruction: "" },
    { id: "review", name: "Review", instruction: "" },
    { id: "done", name: "Done", instruction: "" },
    { id: "col_merged", name: "Merged", instruction: "" },
  ],
  cards: [],
};

function agent(p: Partial<AgentStatus>): AgentStatus {
  return { sessionId: "s1", name: "A", role: "", ticket: null, state: "working", doing: "", cwd: "/r", branch: null, updatedAt: 0, ...p } as AgentStatus;
}

function withCard(columnId: string, assignee: { id: string; name: string; crew?: string }): Board {
  return { ...board, cards: [{ id: "c1", title: "T", columnId, assignee }] };
}

test("roomFor: working agents go to their persona's room", () => {
  expect(roomFor(agent({ persona: "frontend-ux" }), board)).toBe("computer");
  expect(roomFor(agent({ persona: "backend-dev" }), board)).toBe("workshop");
  expect(roomFor(agent({ persona: "editor" }), board)).toBe("comms");
  expect(roomFor(agent({ persona: "release-manager" }), board)).toBe("comms");
  expect(roomFor(agent({ persona: "someone-new" }), board)).toBe("workshop");
  expect(roomFor(agent({}), board)).toBe("workshop");
});

test("roomFor: with no persona id, a matching role still counts", () => {
  expect(roomFor(agent({ role: "Frontend UX" }), board)).toBe("computer");
  expect(roomFor(agent({ role: "Scrum Master", state: "idle" }), board)).toBe("bridge");
});

test("roomFor: waiting on you is the bridge, whatever the job", () => {
  expect(roomFor(agent({ persona: "frontend-ux", state: "waiting", waitingReason: "permission" }), board)).toBe("bridge");
  expect(roomFor(agent({ persona: "backend-dev", state: "waiting" }), withCard("review", { id: "s1", name: "A" }))).toBe("bridge");
});

test("roomFor: the scrum master is always on the bridge", () => {
  expect(roomFor(agent({ persona: "scrum-master", state: "idle" }), board)).toBe("bridge");
  expect(roomFor(agent({ persona: "scrum-master" }), board)).toBe("bridge");
});

test("roomFor: an idle agent with a card in review is in the medbay", () => {
  expect(roomFor(agent({ state: "idle", persona: "frontend-ux" }), withCard("review", { id: "s1", name: "A" }))).toBe("medbay");
});

test("roomFor: working beats a card in review; a busy agent stands in its persona's room", () => {
  const b = withCard("review", { id: "s1", name: "A" });
  expect(roomFor(agent({ persona: "frontend-ux" }), b)).toBe("computer");
  expect(roomFor(agent({ persona: "editor" }), b)).toBe("comms");
  expect(roomFor(agent({}), b)).toBe("workshop");
});

test("roomFor: a review card found by crew id follows the agent across /clear", () => {
  const b = withCard("review", { id: "old-session", name: "A", crew: "a-1" });
  expect(roomFor(agent({ state: "idle", crew: { id: "a-1", name: "A" } }), b)).toBe("medbay");
  expect(roomFor(agent({ state: "idle" }), b)).toBe("mess");
});

test("roomFor: the review stage is read from the column, not its id", () => {
  const b: Board = { columns: [{ id: "col_x", name: "Check", instruction: "", stage: "review" }], cards: [{ id: "c", title: "", columnId: "col_x", assignee: { id: "s1", name: "A" } }] };
  expect(roomFor(agent({ state: "idle" }), b)).toBe("medbay");
});

test("PERSONA_ROOM has a room for every persona in personas/ (the scrum master lives on the bridge)", () => {
  // A new persona file fails this until someone decides where it works.
  const ids = readdirSync(join(import.meta.dir, "..", "personas"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((id) => id !== "scrum-master");
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(PERSONA_ROOM[id], `personas/${id}.md has no PERSONA_ROOM entry`).toBeDefined();
  for (const room of Object.values(PERSONA_ROOM)) expect(ROOM_IDS).toContain(room);
});

test("roomFor: idle agents go to the mess; a card in progress doesn't change that", () => {
  expect(roomFor(agent({ state: "idle", persona: "frontend-ux" }), board)).toBe("mess");
  expect(roomFor(agent({ state: "idle" }), withCard("in-progress", { id: "s1", name: "A" }))).toBe("mess");
});

test("every room's spots, doors and exits are on the map, and spots sit in the room", () => {
  for (const id of ROOM_IDS) {
    const r = ROOMS[id];
    for (const p of [...r.spots, r.door, r.exit]) {
      expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(MAP_W);
      expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(MAP_H);
    }
    for (const p of r.spots) {
      expect(p.x).toBeGreaterThanOrEqual(r.rect.x); expect(p.x).toBeLessThanOrEqual(r.rect.x + r.rect.w);
      expect(p.y).toBeGreaterThanOrEqual(r.rect.y); expect(p.y).toBeLessThanOrEqual(r.rect.y + r.rect.h);
    }
  }
});

test("every door lies on its room's rect edge, or within 30 px of it", () => {
  for (const id of ROOM_IDS) {
    const { rect: r, door: d } = ROOMS[id];
    // Distance from the door to the rect's outline, inside or out.
    const dx = Math.max(r.x - d.x, 0, d.x - (r.x + r.w));
    const dy = Math.max(r.y - d.y, 0, d.y - (r.y + r.h));
    const inside = dx === 0 && dy === 0;
    const toEdge = inside ? Math.min(d.x - r.x, r.x + r.w - d.x, d.y - r.y, r.y + r.h - d.y) : Math.hypot(dx, dy);
    expect({ id, near: toEdge <= 30 }).toEqual({ id, near: true });
  }
});

test("every door-exit leg is straight up or down, so it goes through the doorway", () => {
  for (const id of ROOM_IDS) {
    const { door, exit } = ROOMS[id];
    if (id === "hypersleep") continue; // shares the mess's doorway at an angle
    expect({ id, x: door.x }).toEqual({ id, x: exit.x });
  }
});

test("waypoints: only for real spots, and inside the room", () => {
  for (const id of ROOM_IDS) {
    const { via = {}, spots, rect: r } = ROOMS[id];
    for (const [i, p] of Object.entries(via)) {
      expect(Number(i)).toBeLessThan(spots.length);
      expect(p.x).toBeGreaterThanOrEqual(r.x - 30); expect(p.x).toBeLessThanOrEqual(r.x + r.w + 30);
      expect(p.y).toBeGreaterThanOrEqual(r.y - 30); expect(p.y).toBeLessThanOrEqual(r.y + r.h + 30);
    }
  }
});

test("cargo is label-only: no spots, and roomFor never sends anyone there", () => {
  expect(ROOMS.cargo.spots).toEqual([]);
  for (const state of ["working", "idle", "waiting"] as const)
    for (const persona of ["frontend-ux", "backend-dev", "editor", "scrum-master", ""])
      expect(roomFor(agent({ state, persona }), withCard("review", { id: "s1", name: "A" }))).not.toBe("cargo");
});

test("viaFor: a spot's own waypoint, also for a grid place nearest it; none where the line is clear, or for the door", () => {
  expect(viaFor("medbay", ROOMS.medbay.spots[0]!)).toEqual(ROOMS.medbay.via![0]!);
  expect(viaFor("medbay", ROOMS.medbay.spots[2]!)).toBeUndefined();
  const near = ROOMS.medbay.spots[0]!;
  expect(viaFor("medbay", { x: near.x - 20, y: near.y + 10 })).toEqual(ROOMS.medbay.via![0]!);
  expect(viaFor("medbay", ROOMS.medbay.door)).toBeUndefined();
  expect(viaFor("comms", ROOMS.comms.spots[0]!)).toBeUndefined();
  expect(viaFor("cargo", { x: 300, y: 800 })).toBeUndefined();
});

test("pathBetween: goes round furniture through the spot's waypoint, both ways", () => {
  const from = ROOMS.computer.spots[0]!, to = ROOMS.medbay.spots[0]!;
  const p = pathBetween("computer", from, "medbay", to);
  expect(p.slice(-3)).toEqual([ROOMS.medbay.door, ROOMS.medbay.via![0]!, to]);
  const back = pathBetween("medbay", to, "computer", from);
  expect(back.slice(0, 3)).toEqual([to, ROOMS.medbay.via![0]!, ROOMS.medbay.door]);
});

test("pathBetween: medbay is reached from the lower corridor", () => {
  const p = pathBetween("comms", ROOMS.comms.spots[0]!, "medbay", ROOMS.medbay.spots[2]!);
  expect(p).toContainEqual({ x: 768, y: 638 });
  expect(p).toContainEqual({ x: 1215, y: 638 });
  expect(p).not.toContainEqual({ x: 1215, y: 380 });
});

test("roomsOverlay: every room with its points, the corridors, and a leg per spot", () => {
  const o = roomsOverlay();
  expect(o.rooms.map((r) => r.id)).toEqual(ROOM_IDS);
  expect(o.rooms.find((r) => r.id === "medbay")!.vias).toHaveLength(3);
  const corridors = o.lines.filter((l) => l.kind === "corridor");
  expect(corridors).toContainEqual({ a: { x: 768, y: 312 }, b: { x: 768, y: 638 }, kind: "corridor" });
  expect(corridors.some((l) => l.a.y === 312 && l.b.y === 312)).toBe(true);
  expect(corridors.some((l) => l.a.y === 638 && l.b.y === 638)).toBe(true);
  expect(o.lines.filter((l) => l.kind === "exit")).toHaveLength(ROOM_IDS.length);
  for (const id of ROOM_IDS) {
    const { spots, door, via = {} } = ROOMS[id];
    spots.forEach((s, i) => {
      const v = via[i];
      if (v) {
        expect(o.lines).toContainEqual({ a: door, b: v, kind: "leg" });
        expect(o.lines).toContainEqual({ a: v, b: s, kind: "leg" });
      } else expect(o.lines).toContainEqual({ a: door, b: s, kind: "leg" });
    });
  }
});

test("spotFor: for 1-15 agents in any room, spots stay in the rect and 40 px apart, or the room is full", () => {
  for (const id of ROOM_IDS) {
    const { rect, spots } = ROOMS[id];
    expect(roomSize(id)).toBeGreaterThanOrEqual(spots.length);
    for (let n = 1; n <= 15; n++) {
      const got = Array.from({ length: n }, (_, i) => spotFor(id, i));
      const pts = got.filter((p) => !!p);
      // Past the room's size there is no spot: that is the overflow count.
      expect(pts.length).toBe(Math.min(n, roomSize(id)));
      expect(got.slice(pts.length).every((p) => p === undefined)).toBe(true);
      pts.forEach((p, i) => {
        expect(p.x).toBeGreaterThanOrEqual(rect.x); expect(p.x).toBeLessThanOrEqual(rect.x + rect.w);
        expect(p.y).toBeGreaterThanOrEqual(rect.y); expect(p.y).toBeLessThanOrEqual(rect.y + rect.h);
        for (let j = 0; j < i; j++) {
          // The pods are where the art draws them, 38 px apart.
          if (id === "hypersleep" && i < spots.length) continue;
          expect(Math.hypot(p.x - pts[j]!.x, p.y - pts[j]!.y)).toBeGreaterThanOrEqual(40);
        }
      });
    }
  }
});

test("spotFor: a sprite on a grid place covers no other sprite", () => {
  for (const id of ROOM_IDS) {
    const n = ROOMS[id].spots.length;
    for (let i = n; i < roomSize(id); i++) for (let j = 0; j < i; j++) {
      const p = spotFor(id, i)!, q = spotFor(id, j)!;
      expect(Math.abs(p.x - q.x) >= 40 || Math.abs(p.y - q.y) >= 60).toBe(true);
    }
  }
});

test("placeAll: a full room puts the rest at its door as over, and they take a spot when one frees", () => {
  const size = roomSize("workshop");
  const crew = Array.from({ length: size + 3 }, (_, i) => agent({ sessionId: `s${String(i).padStart(2, "0")}`, persona: "backend-dev" }));
  const one = placeAll(crew, board);
  const over = crew.filter((a) => one.get(a.sessionId)!.over);
  expect(over.map((a) => a.sessionId)).toEqual(crew.slice(size).map((a) => a.sessionId));
  for (const a of over) expect(one.get(a.sessionId)!.at).toEqual(ROOMS.workshop.door);
  expect(new Set([...one.values()].map((p) => p.slot)).size).toBe(crew.length);
  // 12 fit with room to spare (the card's case).
  expect([...placeAll(crew.slice(0, 12), board).values()].some((p) => p.over)).toBe(false);
  // s00 leaves: the first one waiting takes its spot, nobody else moves.
  const two = placeAll(crew.slice(1), board, one);
  expect(two.get(over[0]!.sessionId)).toEqual({ room: "workshop", slot: 0, at: spotFor("workshop", 0)! });
  expect(two.get("s01")).toEqual(one.get("s01")!);
  expect(two.get(over[1]!.sessionId)!.over).toBe(true);
});

test("crowds: one per full room, most urgent first, and tabOrder puts it after the agents in that state", () => {
  const size = roomSize("bridge");
  const waiting = Array.from({ length: size + 1 }, (_, i) => agent({ sessionId: `w${String(i).padStart(2, "0")}`, state: "waiting" }));
  // A scrum master is on the bridge even when idle, and sorts last by key.
  const sm = agent({ sessionId: "z", state: "idle", persona: "scrum-master" });
  const idle = agent({ sessionId: "i", state: "idle" });
  const all = [idle, sm, ...waiting];
  const placed = placeAll(all, board);
  const got = crowds(all, placed);
  expect(got).toHaveLength(1);
  expect(got[0]!.room).toBe("bridge");
  expect(got[0]!.state).toBe("waiting");
  expect(got[0]!.who.map((a) => a.sessionId)).toEqual([waiting.at(-1)!.sessionId, "z"]);
  const order = tabOrder([...all, ...got]);
  expect(order.indexOf(got[0]!)).toBe(waiting.length);
  expect(crowds([idle], placeAll([idle], board))).toEqual([]);
});

test("placeAll: spots go in session-id order, so reordering the list moves nobody", () => {
  const a = agent({ sessionId: "b", state: "idle" }), b = agent({ sessionId: "a", state: "idle" });
  const one = placeAll([a, b], board), two = placeAll([b, a], board);
  expect(one.get("a")).toEqual(two.get("a")!);
  expect(one.get("a")!.slot).toBe(0);
  expect(one.get("b")!.slot).toBe(1);
  expect(one.get("a")!.room).toBe("mess");
});

test("placeAll: someone arriving in a room doesn't move the people already there", () => {
  const stay = agent({ sessionId: "m", state: "idle" });
  const before = placeAll([stay], board);
  expect(before.get("m")!.slot).toBe(0);
  const after = placeAll([stay, agent({ sessionId: "a", state: "idle" })], board, before);
  expect(after.get("m")).toEqual(before.get("m")!);
  expect(after.get("a")!.slot).toBe(1);
});

test("placeAll: a freed spot is reused, and a room change drops the old spot", () => {
  const a = agent({ sessionId: "a", state: "idle" }), b = agent({ sessionId: "b", state: "idle" }), c = agent({ sessionId: "c", state: "idle" });
  const one = placeAll([a, b, c], board);
  const two = placeAll([agent({ sessionId: "a", state: "working" }), b, c], board, one);
  expect(two.get("a")!.room).toBe("workshop");
  expect(two.get("c")!.slot).toBe(2);
  const three = placeAll([agent({ sessionId: "a", state: "idle" }), b, c], board, two);
  expect(three.get("a")!.slot).toBe(0);
  expect(three.get("c")!.slot).toBe(2);
});

test("pathBetween: same room is one straight step", () => {
  const p = pathBetween("mess", { x: 1, y: 1 }, "mess", { x: 2, y: 2 });
  expect(p).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }]);
});

test("pathBetween: rooms on one corridor walk along it, never through the trunk", () => {
  const from = ROOMS.computer.spots[0]!, to = ROOMS.comms.spots[0]!;
  const p = pathBetween("computer", from, "comms", to);
  expect(p[0]).toEqual(from);
  expect(p[p.length - 1]).toEqual(to);
  expect(p).toContainEqual(ROOMS.computer.exit);
  expect(p).toContainEqual(ROOMS.comms.exit);
  expect(p.filter((q) => q.x === 768).length).toBe(0);
});

test("pathBetween: rooms on different corridors cross by the trunk, moving along one axis at a time in the corridors", () => {
  const p = pathBetween("computer", ROOMS.computer.spots[0]!, "mess", ROOMS.mess.spots[0]!);
  const a = p.indexOf(p.find((q) => q.x === ROOMS.computer.exit.x && q.y === ROOMS.computer.exit.y)!);
  const b = p.indexOf(p.find((q) => q.x === ROOMS.mess.exit.x && q.y === ROOMS.mess.exit.y)!);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  for (let i = a + 1; i <= b; i++) {
    expect(p[i]!.x === p[i - 1]!.x || p[i]!.y === p[i - 1]!.y).toBe(true);
  }
  expect(p).toContainEqual({ x: 768, y: ROOMS.computer.exit.y });
  expect(p).toContainEqual({ x: 768, y: ROOMS.mess.exit.y });
});

test("pathBetween: the bridge, whose exit is on the trunk, has no repeated points", () => {
  const p = pathBetween("bridge", ROOMS.bridge.spots[0]!, "hypersleep", ROOMS.hypersleep.spots[0]!);
  for (let i = 1; i < p.length; i++) expect(p[i]).not.toEqual(p[i - 1]!);
});

test("pointAlong walks the path and stops at its ends", () => {
  const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  expect(pathLength(path)).toBe(20);
  expect(pointAlong(path, -5)).toEqual({ x: 0, y: 0 });
  expect(pointAlong(path, 5)).toEqual({ x: 5, y: 0 });
  expect(pointAlong(path, 15)).toEqual({ x: 10, y: 5 });
  expect(pointAlong(path, 99)).toEqual({ x: 10, y: 10 });
  expect(pointAlong([{ x: 3, y: 4 }], 7)).toEqual({ x: 3, y: 4 });
});

test("sleepers: assignees of open cards with no live session, once each", () => {
  const b: Board = {
    ...board,
    cards: [
      { id: "c1", title: "", columnId: "in-progress", assignee: { id: "gone", name: "KANE", crew: "kane-1" } },
      { id: "c2", title: "", columnId: "backlog", assignee: { id: "gone2", name: "KANE", crew: "kane-1" } },
      { id: "c3", title: "", columnId: "review", assignee: { id: "live", name: "ASH" } },
      { id: "c4", title: "", columnId: "review", assignee: { id: "cleared", name: "LAMBERT", crew: "lam-1" } },
      { id: "c5", title: "", columnId: "done", assignee: { id: "gone3", name: "PARKER" } },
      { id: "c6", title: "", columnId: "col_merged", assignee: { id: "gone4", name: "BRETT" } },
      { id: "c7", title: "", columnId: "backlog", assignee: null },
    ],
  };
  const live = [agent({ sessionId: "live" }), agent({ sessionId: "new", crew: { id: "lam-1", name: "LAMBERT" } })];
  expect(sleepers(b, live)).toEqual([{ who: { id: "gone", name: "KANE", crew: "kane-1" }, cardId: "c1" }]);
});

test("cargoCount: cards in the done column or any column after it", () => {
  const b: Board = {
    ...board,
    cards: ["backlog", "review", "done", "done", "col_merged"].map((columnId, i) => ({ id: `c${i}`, title: "", columnId })),
  };
  expect(cargoCount(b)).toBe(3);
  expect(cargoCount({ columns: [], cards: [] })).toBe(0);
});

test("viewFromHash / hashForView: the game view has its own hash", () => {
  expect(viewFromHash("#game")).toBe("game");
  expect(hashForView("game")).toBe("game");
  expect(hashForView("mood")).toBe("mood");
  expect(hashForView("workshop")).toBe("");
  for (const v of ["workshop", "mood", "game"] as const) expect(viewFromHash(`#${hashForView(v)}`)).toBe(v);
});

test("hashFlag: the ROOMS overlay is on only with rooms=1 after the page", () => {
  expect(viewFromHash("#game?rooms=1")).toBe("game");
  expect(hashFlag("#game?rooms=1", "rooms")).toBe(true);
  expect(hashFlag("#game?x=2&rooms=1", "rooms")).toBe(true);
  expect(hashFlag("#game", "rooms")).toBe(false);
  expect(hashFlag("", "rooms")).toBe(false);
  expect(hashFlag("#game?rooms=0", "rooms")).toBe(false);
  expect(hashFlag("#game?rooms", "rooms")).toBe(false);
  expect(hashFlag("#rooms=1", "rooms")).toBe(false);
});

test("tabOrder: waiting, then working, then idle, each in snapshot order", () => {
  const list = [
    agent({ sessionId: "i1", state: "idle" }),
    agent({ sessionId: "w1", state: "working" }),
    agent({ sessionId: "q1", state: "waiting" }),
    agent({ sessionId: "i2", state: "idle" }),
    agent({ sessionId: "q2", state: "waiting" }),
    agent({ sessionId: "w2", state: "working" }),
  ];
  expect(tabOrder(list).map((a) => a.sessionId)).toEqual(["q1", "q2", "w1", "w2", "i1", "i2"]);
  // The snapshot itself is left alone.
  expect(list[0]!.sessionId).toBe("i1");
  expect(tabOrder([])).toEqual([]);
});

test("scrollToShow: centres the point, clamped to the map; no point centres the map", () => {
  const map = { w: 720, h: 480 }, view = { w: 390, h: 600 };
  // A bridge spot: x 768 of 1536 is the map's middle.
  expect(scrollToShow({ x: 768, y: 200 }, map, view)).toEqual({ left: 165, top: 0 });
  // Far right (comms) clamps to the right edge, far left to 0.
  expect(scrollToShow({ x: 1385, y: 262 }, map, view).left).toBe(720 - 390);
  expect(scrollToShow({ x: 150, y: 262 }, map, view).left).toBe(0);
  expect(scrollToShow(undefined, map, view)).toEqual({ left: 165, top: 0 });
  // Taller than the box: scrolls down too.
  expect(scrollToShow({ x: 768, y: 1000 }, { w: 720, h: 480 }, { w: 390, h: 200 }).top).toBe(280);
  // A map that fits never scrolls.
  expect(scrollToShow({ x: 1500, y: 1000 }, map, { w: 800, h: 600 })).toEqual({ left: 0, top: 0 });
});

test("nudgeInto: slides a tag back inside the box", () => {
  const box = { left: 0, right: 390 };
  expect(nudgeInto({ left: 100, right: 300 }, box)).toBe(0);
  expect(nudgeInto({ left: 300, right: 500 }, box)).toBe(-114);
  expect(nudgeInto({ left: -50, right: 150 }, box)).toBe(54);
  // Wider than the box: keep its left edge in view.
  expect(nudgeInto({ left: 100, right: 600 }, box)).toBe(-96);
});

// Walks: the bookkeeping GameView redraws every frame. At 260 px/s.
const crewAgent = (sessionId: string, crew: string, p: Partial<AgentStatus> = {}) => agent({ sessionId, crew: { id: crew, name: crew }, ...p });

test("stepWalks: the first snapshot places everyone where they stand, no walking", () => {
  const a = agent({ sessionId: "a", state: "idle" });
  const placed = placeAll([a], board);
  const walks = stepWalks(new Map(), [a], placed, 1000, { reduceMotion: false, primed: false });
  expect(walks.get("a")!.path).toEqual([placed.get("a")!.at]);
  expect(walks.get("a")!.len).toBe(0);
});

test("stepWalks: once primed, a newcomer walks in from the airlock", () => {
  const a = agent({ sessionId: "a", state: "idle" });
  const placed = placeAll([a], board);
  const w = stepWalks(new Map(), [a], placed, 1000, { reduceMotion: false, primed: true }).get("a")!;
  expect(w.path[0]).toEqual(spotFor("airlock", 0)!);
  expect(w.path.at(-1)).toEqual(placed.get("a")!.at);
  expect(w.start).toBe(1000);
  expect(w.len).toBeGreaterThan(0);
});

test("stepWalks: nothing changed keeps the walk as it was", () => {
  const a = agent({ sessionId: "a", state: "idle" });
  const placed = placeAll([a], board);
  const one = stepWalks(new Map(), [a], placed, 1000, { reduceMotion: false, primed: true });
  const two = stepWalks(one, [a], placed, 2000, { reduceMotion: false, primed: true });
  expect(two.get("a")).toBe(one.get("a")!);
});

test("stepWalks: a room change mid-walk sets off from where the agent is now, not the old target", () => {
  const idle = agent({ sessionId: "a", state: "idle" });
  const p1 = placeAll([idle], board);
  const one = stepWalks(new Map(), [idle], p1, 0, { reduceMotion: false, primed: true });
  const w1 = one.get("a")!;
  // Half a second into the walk in from the airlock, it is sent to the workshop.
  const busy = agent({ sessionId: "a", state: "working" });
  const p2 = placeAll([busy], board, p1);
  const w2 = stepWalks(one, [busy], p2, 500, { reduceMotion: false, primed: true }).get("a")!;
  const here = pointAlong(w1.path, 130);
  expect(w2.path[0]).toEqual(here);
  expect(w2.path[0]).not.toEqual(p1.get("a")!.at);
  expect(w2.path.at(-1)).toEqual(p2.get("a")!.at);
  expect(w2.room).toBe("workshop");
  expect(w2.start).toBe(500);
});

test("stepWalks: with reduced motion every move is a jump", () => {
  const idle = agent({ sessionId: "a", state: "idle" });
  const p1 = placeAll([idle], board);
  const one = stepWalks(new Map(), [idle], p1, 0, { reduceMotion: true, primed: true });
  expect(one.get("a")!.path).toEqual([p1.get("a")!.at]);
  const busy = agent({ sessionId: "a", state: "working" });
  const p2 = placeAll([busy], board, p1);
  expect(stepWalks(one, [busy], p2, 100, { reduceMotion: true, primed: true }).get("a")!.path).toEqual([p2.get("a")!.at]);
});

const motion = { reduceMotion: false, primed: true };
const POD = ROOMS.hypersleep.spots;

test("stepWalks: an agent that leaves walks to the airlock, then is dropped", () => {
  const a = agent({ sessionId: "a", state: "idle" }), b = agent({ sessionId: "b", state: "idle" });
  const p1 = placeAll([a, b], board);
  const one = stepWalks(new Map(), [a, b], p1, 0, { reduceMotion: false, primed: false });
  const p2 = placeAll([b], board, p1);
  const two = stepWalks(one, [b], p2, 100, motion);
  const out = two.get("a")!;
  expect(out.room).toBe("airlock");
  expect(out.path[0]).toEqual(p1.get("a")!.at);
  expect(out.path.at(-1)).toEqual(spotFor("airlock", 0)!);
  expect(out.start).toBe(100);
  // Still on the way: kept as it is, and drawn. There: not drawn, then dropped.
  expect(stepWalks(two, [b], p2, 200, motion).get("a")).toBe(out);
  expect(walkersAt(two, 200).at.has("a")).toBe(true);
  const there = 100 + (out.len / 260) * 1000 + 1;
  expect(walkersAt(two, there)).toEqual({ at: new Map([["b", p2.get("b")!.at]]), moving: false });
  expect([...stepWalks(two, [b], p2, there, motion).keys()]).toEqual(["b"]);
});

test("stepWalks: a leaver who still holds an open card walks to the next free pod and stays", () => {
  const a = crewAgent("s-a", "a-1", { state: "idle" });
  const b = withCard("in-progress", { id: "s-a", name: "A", crew: "a-1" });
  b.cards.unshift({ id: "c0", title: "T", columnId: "review", assignee: { id: "s-z", name: "Z", crew: "z-1" } });
  const p1 = placeAll([a], b);
  // Z was asleep on load: lying in pod 0, no walk.
  const one = stepWalks(new Map(), [a], p1, 0, { reduceMotion: false, primed: false, asleep: sleepers(b, [a]) });
  expect(one.get("z-1")).toMatchObject({ room: "hypersleep", to: POD[0]!, path: [POD[0]!] });
  const two = stepWalks(one, [], new Map(), 100, { ...motion, asleep: sleepers(b, []) });
  expect(two.get("z-1")).toBe(one.get("z-1")!);
  const w = two.get("a-1")!;
  expect(w.room).toBe("hypersleep");
  expect(w.path[0]).toEqual(p1.get("a-1")!.at);
  expect(w.to).toEqual(POD[1]!);
  // Z's card is finished: Z walks out, A keeps pod 1 rather than shuffling up.
  b.cards[0]!.columnId = "done";
  const three = stepWalks(two, [], new Map(), 60_000, { ...motion, asleep: sleepers(b, []) });
  expect(three.get("a-1")).toBe(w);
  expect(three.get("z-1")!.room).toBe("airlock");
});

test("stepWalks: a sleeper whose session comes back walks from its pod to its room", () => {
  const b = withCard("in-progress", { id: "old", name: "A", crew: "a-1" });
  const one = stepWalks(new Map(), [], new Map(), 0, { reduceMotion: false, primed: false, asleep: sleepers(b, []) });
  const back = crewAgent("new", "a-1", { state: "idle" });
  const placed = placeAll([back], b);
  const w = stepWalks(one, [back], placed, 100, { ...motion, asleep: sleepers(b, [back]) }).get("a-1")!;
  expect(w.room).toBe("mess");
  expect(w.path[0]).toEqual(POD[0]!);
  expect(w.path.at(-1)).toEqual(placed.get("a-1")!.at);
});

test("stepWalks: with every pod taken, a leaver on a card goes out by the airlock", () => {
  const b: Board = { ...board, cards: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id: `c-${id}`, title: "T", columnId: "review", assignee: { id, name: id } })) };
  const f = agent({ sessionId: "f", state: "idle" });
  const one = stepWalks(new Map(), [f], placeAll([f], b), 0, { reduceMotion: false, primed: false, asleep: sleepers(b, [f]) });
  const two = stepWalks(one, [], new Map(), 100, { ...motion, asleep: sleepers(b, []) });
  expect(two.get("f")!.room).toBe("airlock");
  expect([...two.values()].filter((w) => w.room === "hypersleep").map((w) => w.to)).toEqual(POD);
});

test("stepWalks: with reduced motion a leaver just goes, or is in its pod at once", () => {
  const a = agent({ sessionId: "a", state: "idle" }), c = agent({ sessionId: "c", state: "idle" });
  const b = withCard("in-progress", { id: "a", name: "A" });
  const one = stepWalks(new Map(), [a, c], placeAll([a, c], b), 0, { reduceMotion: true, primed: true });
  const two = stepWalks(one, [], new Map(), 100, { reduceMotion: true, primed: true, asleep: sleepers(b, []) });
  expect([...two.keys()]).toEqual(["a"]);
  expect(two.get("a")).toMatchObject({ room: "hypersleep", path: [POD[0]!], len: 0 });
});

test("pathBetween: the mess and hypersleep share a corridor point, so it is door to door", () => {
  const p = pathBetween("mess", ROOMS.mess.spots[0]!, "hypersleep", POD[0]!);
  expect(p).toEqual([ROOMS.mess.spots[0]!, ROOMS.mess.door, ROOMS.hypersleep.door, POD[0]!]);
});

test("stepWalks: an agent with no placement is skipped, not crashed on", () => {
  const a = agent({ sessionId: "a", state: "idle" });
  expect(stepWalks(new Map(), [a], new Map(), 0, { reduceMotion: false, primed: true }).size).toBe(0);
});

test("placeAll + stepWalks: a /clear (new session id, same crew) keeps the spot and the walk", () => {
  // Two in the mess. The one on spot 0 leaves as the one on spot 1 is cleared:
  // spot 0 is now free, but the cleared agent must stay on spot 1, not walk.
  const gone = crewAgent("g", "g-1", { state: "idle" }), cleared = crewAgent("z", "z-1", { state: "idle" });
  const p1 = placeAll([gone, cleared], board);
  expect(p1.get("z-1")!.slot).toBe(1);
  const one = stepWalks(new Map(), [gone, cleared], p1, 0, { reduceMotion: false, primed: true });
  const after = crewAgent("a-new", "z-1", { state: "idle" });
  const p2 = placeAll([after], board, p1);
  expect(p2.get("z-1")).toEqual(p1.get("z-1")!);
  const two = stepWalks(one, [after], p2, 5000, { reduceMotion: false, primed: true });
  expect(two.get("z-1")).toBe(one.get("z-1")!);
});

test("agentKey: crew id when there is one, else the session id", () => {
  expect(agentKey(crewAgent("s", "c-1"))).toBe("c-1");
  expect(agentKey(agent({ sessionId: "s" }))).toBe("s");
});

test("walkersAt: where each walk is at a time, and whether anyone is still moving", () => {
  const a = agent({ sessionId: "a", state: "idle" });
  const walks = stepWalks(new Map(), [a], placeAll([a], board), 0, { reduceMotion: false, primed: true });
  const w = walks.get("a")!;
  const mid = walkersAt(walks, 1000);
  expect(mid.moving).toBe(true);
  expect(mid.at.get("a")).toEqual(pointAlong(w.path, 260));
  const end = walkersAt(walks, 60_000);
  expect(end.moving).toBe(false);
  expect(end.at.get("a")).toEqual(w.to);
});
