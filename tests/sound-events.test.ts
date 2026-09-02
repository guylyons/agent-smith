import { test, expect } from "bun:test";
import { soundTransitions, boardMoves, isCompletion } from "../src/ui/soundEvents";
import type { AgentStatus } from "../src/schema";
import { defaultBoard } from "../src/lib/board";
import type { Board } from "../src/lib/board";

const A = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 1000, ...o,
});

test("baseline snapshot records states but fires nothing (unprimed)", () => {
  const { cues, next } = soundTransitions(new Map(), [A({ state: "waiting", waitingReason: "question" })], false);
  expect(cues).toEqual([]);
  expect(next.get("s")).toBe("waiting");
});

test("working -> waiting(question) fires a question cue", () => {
  const prev = new Map([["s", "working" as const]]);
  const { cues } = soundTransitions(prev, [A({ state: "waiting", waitingReason: "question" })], true);
  expect(cues).toEqual(["question"]);
});

test("working -> waiting(permission) fires a permission cue", () => {
  const prev = new Map([["s", "working" as const]]);
  const { cues } = soundTransitions(prev, [A({ state: "waiting", waitingReason: "permission" })], true);
  expect(cues).toEqual(["permission"]);
});

test("waiting with no reason is treated as permission", () => {
  const prev = new Map([["s", "working" as const]]);
  const { cues } = soundTransitions(prev, [A({ state: "waiting" })], true);
  expect(cues).toEqual(["permission"]);
});

test("working -> idle fires a completion cue", () => {
  const prev = new Map([["s", "working" as const]]);
  const { cues } = soundTransitions(prev, [A({ state: "idle" })], true);
  expect(cues).toEqual(["completion"]);
});

test("an unchanged state fires nothing", () => {
  const prev = new Map([["s", "waiting" as const]]);
  const { cues } = soundTransitions(prev, [A({ state: "waiting", waitingReason: "question" })], true);
  expect(cues).toEqual([]);
});

test("a newly appearing idle agent does not fire completion", () => {
  // completion is only for a working -> idle transition, never a first sighting.
  const { cues } = soundTransitions(new Map(), [A({ state: "idle" })], true);
  expect(cues).toEqual([]);
});

test("idle -> idle (no prior working) fires nothing", () => {
  const prev = new Map([["s", "idle" as const]]);
  const { cues } = soundTransitions(prev, [A({ state: "idle" })], true);
  expect(cues).toEqual([]);
});

test("multiple agents each report their own transition, in order", () => {
  const prev = new Map([
    ["a", "working" as const],
    ["b", "working" as const],
  ]);
  const agents = [
    A({ sessionId: "a", state: "idle" }),
    A({ sessionId: "b", state: "waiting", waitingReason: "question" }),
  ];
  const { cues, next } = soundTransitions(prev, agents, true);
  expect(cues).toEqual(["completion", "question"]);
  expect(next.get("a")).toBe("idle");
  expect(next.get("b")).toBe("waiting");
});

test("a disappeared agent is dropped from the carried-forward state", () => {
  const prev = new Map([
    ["gone", "working" as const],
    ["here", "working" as const],
  ]);
  const { next } = soundTransitions(prev, [A({ sessionId: "here", state: "working" })], true);
  expect(next.has("gone")).toBe(false);
  expect(next.has("here")).toBe(true);
});

// --- board moves (card column changes) ------------------------------------

const board = (cards: Array<{ id: string; columnId: string; title?: string }>): Board => ({
  columns: [
    { id: "backlog", name: "Backlog", instruction: "" },
    { id: "review", name: "Review", instruction: "" },
    { id: "done", name: "Done", instruction: "" },
  ],
  cards: cards.map((c) => ({ id: c.id, title: c.title ?? c.id, columnId: c.columnId })),
});

test("baseline board records columns but reports no moves (unprimed)", () => {
  const { moves, next } = boardMoves(new Map(), board([{ id: "k1", columnId: "backlog" }]), false);
  expect(moves).toEqual([]);
  expect(next.get("k1")).toBe("backlog");
});

test("a card changing column is reported as a move", () => {
  const prev = new Map([["k1", "backlog"]]);
  const { moves } = boardMoves(prev, board([{ id: "k1", columnId: "done", title: "Ship it" }]), true);
  expect(moves).toEqual([{ cardId: "k1", title: "Ship it", from: "backlog", to: "done" }]);
});

test("a card staying in its column reports nothing", () => {
  const prev = new Map([["k1", "backlog"]]);
  const { moves } = boardMoves(prev, board([{ id: "k1", columnId: "backlog" }]), true);
  expect(moves).toEqual([]);
});

test("a newly added card is recorded but not reported as a move", () => {
  const prev = new Map([["k1", "backlog"]]);
  const { moves, next } = boardMoves(prev, board([{ id: "k1", columnId: "backlog" }, { id: "k2", columnId: "backlog" }]), true);
  expect(moves).toEqual([]);
  expect(next.get("k2")).toBe("backlog");
});

test("a removed card is dropped from the carried-forward columns", () => {
  const prev = new Map([["k1", "backlog"], ["gone", "done"]]);
  const { next } = boardMoves(prev, board([{ id: "k1", columnId: "backlog" }]), true);
  expect(next.has("gone")).toBe(false);
});

test("isCompletion is true only for a move into the done column", () => {
  const b = defaultBoard();
  expect(isCompletion({ cardId: "k", title: "t", from: "review", to: "done" }, b)).toBe(true);
  expect(isCompletion({ cardId: "k", title: "t", from: "backlog", to: "review" }, b)).toBe(false);
});

test("isCompletion keys off the column's stage, not the stock id", () => {
  const b = {
    columns: [
      { id: "done", name: "Done", instruction: "", stage: "done" as const },
      { id: "col_x", name: "Shipped", instruction: "", stage: "done" as const },
      { id: "col_y", name: "Archived", instruction: "" },
    ],
    cards: [],
  };
  expect(isCompletion({ cardId: "k", title: "t", from: "a", to: "col_x" }, b)).toBe(true);
  expect(isCompletion({ cardId: "k", title: "t", from: "a", to: "col_y" }, b)).toBe(false);
  expect(isCompletion({ cardId: "k", title: "t", from: "a", to: "done" }, b)).toBe(true);
});
