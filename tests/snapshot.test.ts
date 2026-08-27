import { test, expect } from "bun:test";
import { buildSnapshot, workLabel } from "../src/lib/snapshot";
import type { Snapshot } from "../src/lib/snapshot";
import type { AgentStatus } from "../src/schema";

const A = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 1000, ...o,
});

const labelsIn = (snap: Snapshot, stage: string) =>
  snap.line.find((s) => s.stage === stage)!.items.map((i) => i.label);

test("drops stale agents", () => {
  const stale = buildSnapshot([A({ updatedAt: 0 })], 1000, { staleMs: 500 });
  expect(stale.agents.length).toBe(0);

  const fresh = buildSnapshot([A({ updatedAt: 900 })], 1000, { staleMs: 500 });
  expect(fresh.agents.length).toBe(1);
});

test("waiting beats working for same ticket", () => {
  const snap = buildSnapshot(
    [A({ sessionId: "1", state: "working", ticket: "#7" }),
     A({ sessionId: "2", state: "waiting", ticket: "#7" })], 1000);
  expect(labelsIn(snap, "needs")).toContain("#7");
  expect(labelsIn(snap, "working")).not.toContain("#7");
});

test("a ticketless working session still shows on THE LINE (labelled by branch)", () => {
  const snap = buildSnapshot([A({ ticket: null, branch: "keymap-cleanup", state: "working" })], 1000);
  expect(labelsIn(snap, "working")).toEqual(["keymap-cleanup"]);
});

test("workLabel: ticket > short branch > repo", () => {
  expect(workLabel(A({ ticket: "#9" }))).toBe("#9");
  expect(workLabel(A({ ticket: null, branch: "feature/xyz-thing" }))).toBe("xyz-thing");
  expect(workLabel(A({ ticket: null, branch: "HEAD", cwd: "/Users/x/agentsmith" }))).toBe("agentsmith");
});

test("the same ticket in two different repos stays two separate crates", () => {
  const snap = buildSnapshot([
    A({ sessionId: "1", ticket: "#117", cwd: "/x/mho-drupal", state: "working" }),
    A({ sessionId: "2", ticket: "#117", cwd: "/x/design-system", state: "working" }),
  ], 1000);
  expect(labelsIn(snap, "working")).toEqual(["#117", "#117"]); // two crates, not merged
});

test("duplicate codenames are made unique within the view", () => {
  const snap = buildSnapshot([
    A({ sessionId: "aaaa1111", name: "SABLE", cwd: "/a" }),
    A({ sessionId: "bbbb2222", name: "SABLE", cwd: "/b" }),
  ], 1000);
  const names = snap.agents.map((a) => a.name);
  expect(new Set(names).size).toBe(2);
  expect(names.every((n) => n.startsWith("SABLE"))).toBe(true);
});

test("the six stages are always present, in lifecycle order", () => {
  const snap = buildSnapshot([A({})], 1000);
  expect(snap.line.map((s) => s.stage)).toEqual(
    ["backlog", "working", "needs", "done", "review", "merged"]);
});

// --- new: git-lifecycle stages ------------------------------------------------

test("an idle session with committed-but-unpushed work lands in DONE", () => {
  const snap = buildSnapshot(
    [A({ ticket: "#5", state: "idle", cwd: "/repo" })], 1000,
    { committedCwds: new Set(["/repo"]) });
  expect(labelsIn(snap, "done")).toEqual(["#5"]);
  expect(labelsIn(snap, "backlog")).toEqual([]);
});

test("an idle session with nothing committed is BACKLOG (not begun)", () => {
  const snap = buildSnapshot([A({ ticket: "#5", state: "idle", cwd: "/repo" })], 1000);
  expect(labelsIn(snap, "backlog")).toEqual(["#5"]);
  expect(labelsIn(snap, "done")).toEqual([]);
});

test("an actively working session is WORKING even with unpushed commits", () => {
  const snap = buildSnapshot(
    [A({ ticket: "#5", state: "working", cwd: "/repo" })], 1000,
    { committedCwds: new Set(["/repo"]) });
  expect(labelsIn(snap, "working")).toEqual(["#5"]);
  expect(labelsIn(snap, "done")).toEqual([]);
});

// --- new: user designations ---------------------------------------------------

test("a user designation wins over the derived live stage", () => {
  const snap = buildSnapshot(
    [A({ ticket: "#8", state: "idle", cwd: "/repo" })], 1000,
    {
      committedCwds: new Set(["/repo"]), // would otherwise be DONE
      designations: { "repo|#8": { stage: "review", label: "#8", sessionId: "s" } },
    });
  expect(labelsIn(snap, "review")).toEqual(["#8"]);
  expect(labelsIn(snap, "done")).toEqual([]);
});

test("a designated item with no live session still renders its crate", () => {
  const snap = buildSnapshot([], 1000, {
    designations: { "repo|#9": { stage: "merged", label: "#9", sessionId: "gone" } },
  });
  const merged = snap.line.find((s) => s.stage === "merged")!;
  expect(merged.items).toEqual([{ key: "repo|#9", label: "#9", sessionId: "gone", stage: "merged" }]);
});

test("line items carry their key and sessionId for click-through", () => {
  const snap = buildSnapshot([A({ sessionId: "sid1", ticket: "#3", state: "working", cwd: "/x/repo" })], 1000);
  const item = snap.line.find((s) => s.stage === "working")!.items[0]!;
  expect(item.sessionId).toBe("sid1");
  expect(item.key).toBe("repo|#3");
});
