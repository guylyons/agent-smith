import { test, expect } from "bun:test";
import { diffNotifications, type Notif } from "../src/lib/notifications";
import { notifFocus } from "../src/ui/NotificationCenter";
import type { Board } from "../src/lib/board";
import type { AgentStatus } from "../src/schema";

const COLS = [
  { id: "backlog", name: "Backlog", instruction: "" },
  { id: "in-progress", name: "In Progress", instruction: "" },
  { id: "review", name: "Review", instruction: "" },
  { id: "done", name: "Done", instruction: "" },
];

function board(cards: Board["cards"]): Board {
  return { columns: COLS, cards };
}
function agent(sessionId: string, name: string, state: AgentStatus["state"], extra: Partial<AgentStatus> = {}): AgentStatus {
  return { sessionId, name, state, ...extra } as AgentStatus;
}
const snap = (agents: AgentStatus[], b: Board) => ({ agents, board: b });

test("the first snapshot emits nothing (no prev to diff against)", () => {
  const curr = snap([], board([{ id: "c1", title: "T", columnId: "backlog", comments: [{ id: "m1", author: "VOLT", text: "hi", at: 1 }] }]));
  expect(diffNotifications(null, curr, "You", 100)).toEqual([]);
});

test("a new agent comment is surfaced", () => {
  const prev = snap([], board([{ id: "c1", title: "Fix bug", columnId: "backlog", comments: [] }]));
  const curr = snap([], board([{ id: "c1", title: "Fix bug", columnId: "backlog", comments: [{ id: "m1", author: "VOLT", text: "Root cause found", at: 5 }] }]));
  const out = diffNotifications(prev, curr, "You", 100);
  expect(out.length).toBe(1);
  expect(out[0]).toMatchObject({ kind: "comment", cardId: "c1", cardTitle: "Fix bug", who: "VOLT", text: "Root cause found", commentId: "m1" });
});

test("my own comments never notify me", () => {
  const prev = snap([], board([{ id: "c1", title: "T", columnId: "backlog", comments: [] }]));
  const curr = snap([], board([{ id: "c1", title: "T", columnId: "backlog", comments: [{ id: "m1", author: "You", text: "note", at: 5 }] }]));
  expect(diffNotifications(prev, curr, "You", 100)).toEqual([]);
});

test("a comment already seen last snapshot is not re-emitted", () => {
  const withComment = board([{ id: "c1", title: "T", columnId: "backlog", comments: [{ id: "m1", author: "VOLT", text: "hi", at: 5 }] }]);
  expect(diffNotifications(snap([], withComment), snap([], withComment), "You", 100)).toEqual([]);
});

test("an agent entering the waiting state raises a needs-you", () => {
  const prev = snap([agent("s1", "VOLT", "working")], board([]));
  const curr = snap([agent("s1", "VOLT", "waiting", { waitingReason: "question" })], board([]));
  const out = diffNotifications(prev, curr, "You", 100);
  expect(out.length).toBe(1);
  expect(out[0]).toMatchObject({ kind: "needs-you", who: "VOLT", sessionId: "s1" });
  expect(out[0]!.text).toContain("question");
});

test("a session that stays waiting does not keep re-notifying", () => {
  const waiting = snap([agent("s1", "VOLT", "waiting", { waitingReason: "plan" })], board([]));
  expect(diffNotifications(waiting, waiting, "You", 100)).toEqual([]);
});

test("a card moved forward is surfaced; the assignee is credited", () => {
  const prev = snap([], board([{ id: "c1", title: "Fix bug", columnId: "in-progress", assignee: { id: "s1", name: "VOLT" }, comments: [] }]));
  const curr = snap([], board([{ id: "c1", title: "Fix bug", columnId: "review", assignee: { id: "s1", name: "VOLT" }, comments: [] }]));
  const out = diffNotifications(prev, curr, "You", 100);
  expect(out.length).toBe(1);
  expect(out[0]).toMatchObject({ kind: "move", cardId: "c1", cardTitle: "Fix bug", who: "VOLT" });
  expect(out[0]!.text.toLowerCase()).toContain("review");
});

test("a backward move (e.g. review -> in-progress) is not surfaced", () => {
  const prev = snap([], board([{ id: "c1", title: "T", columnId: "review", comments: [] }]));
  const curr = snap([], board([{ id: "c1", title: "T", columnId: "in-progress", comments: [] }]));
  expect(diffNotifications(prev, curr, "You", 100)).toEqual([]);
});

test("event ids are stable per event and unique across kinds", () => {
  const prev = snap([agent("s1", "VOLT", "working")], board([{ id: "c1", title: "T", columnId: "in-progress", comments: [] }]));
  const curr = snap(
    [agent("s1", "VOLT", "waiting", { waitingReason: "question", stateSince: 7 })],
    board([{ id: "c1", title: "T", columnId: "review", comments: [{ id: "m1", author: "VOLT", text: "done", at: 6 }] }]),
  );
  const ids = diffNotifications(prev, curr, "You", 100).map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length); // all unique
  expect(ids).toContain("comment:m1"); // comment id is stable across snapshots
});

// Clicking a notice lands on the exact thing it announced.
const notif = (o: Partial<Notif>): Notif => ({ id: "x", kind: "comment", at: 0, who: "VOLT", text: "", ...o });

test("a comment notice lands on that comment", () => {
  expect(notifFocus(notif({ kind: "comment", cardId: "c1", commentId: "m1" }))).toEqual({ kind: "comment", id: "m1" });
});

test("a move notice lands on the card's stage", () => {
  expect(notifFocus(notif({ kind: "move", cardId: "c1" }))).toEqual({ kind: "stage" });
});

test("a needs-you notice, or a comment notice without its id, has no spot on the card", () => {
  expect(notifFocus(notif({ kind: "needs-you", sessionId: "s1" }))).toBeUndefined();
  expect(notifFocus(notif({ kind: "comment", cardId: "c1" }))).toBeUndefined();
});
