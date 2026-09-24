// tests/game.test.ts — the GAME view's rules: which room an agent stands in,
// where, and the corridor path between rooms. Drawing it was checked in the
// browser.
import { test, expect } from "bun:test";
import { roomFor, spotFor, placeAll, pathBetween, pathLength, pointAlong, sleepers, cargoCount, viaFor, roomsOverlay, ROOMS, ROOM_IDS, MAP_W, MAP_H } from "../src/ui/game";
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

test("roomFor: a card in review puts its agent in the medbay, idle or not", () => {
  const b = withCard("review", { id: "s1", name: "A" });
  expect(roomFor(agent({ persona: "frontend-ux" }), b)).toBe("medbay");
  expect(roomFor(agent({ state: "idle" }), b)).toBe("medbay");
});

test("roomFor: a review card found by crew id follows the agent across /clear", () => {
  const b = withCard("review", { id: "old-session", name: "A", crew: "a-1" });
  expect(roomFor(agent({ crew: { id: "a-1", name: "A" } }), b)).toBe("medbay");
  expect(roomFor(agent({}), b)).toBe("workshop");
});

test("roomFor: the review stage is read from the column, not its id", () => {
  const b: Board = { columns: [{ id: "col_x", name: "Check", instruction: "", stage: "review" }], cards: [{ id: "c", title: "", columnId: "col_x", assignee: { id: "s1", name: "A" } }] };
  expect(roomFor(agent({}), b)).toBe("medbay");
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

test("viaFor: a spot's own waypoint, also for agents fanned out past it; none where the line is clear", () => {
  expect(viaFor("medbay", ROOMS.medbay.spots[0]!)).toEqual(ROOMS.medbay.via![0]!);
  expect(viaFor("medbay", ROOMS.medbay.spots[2]!)).toBeUndefined();
  const n = ROOMS.medbay.spots.length;
  expect(viaFor("medbay", spotFor("medbay", n))).toEqual(ROOMS.medbay.via![0]!);
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

test("spotFor: no two of the first twenty agents in a room share a spot", () => {
  for (const id of ROOM_IDS) {
    if (!ROOMS[id].spots.length) continue;
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) { const p = spotFor(id, i); seen.add(`${p.x},${p.y}`); }
    expect(seen.size).toBe(20);
  }
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
