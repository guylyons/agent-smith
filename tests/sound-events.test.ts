import { test, expect } from "bun:test";
import { soundTransitions } from "../src/ui/soundEvents";
import type { AgentStatus } from "../src/schema";

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
