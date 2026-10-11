import { test, expect } from "bun:test";
import { diffNotifications, landsMerge, type Notif } from "../src/lib/notifications";
import { shiftLogText, shiftLogView, clockTime, isShiftEvent, publishShiftLog, shiftLogSnapshot, SHIFT_LOG_STILL, SHIFT_LOG_CAP } from "../src/ui/shiftEvents";
import type { Board } from "../src/lib/board";

// A board with a stageless "Merged" past Done, like THE LINE's.
const COLS: Board["columns"] = [
  { id: "backlog", name: "Backlog", instruction: "", stage: "todo" },
  { id: "in-progress", name: "In Progress", instruction: "", stage: "doing" },
  { id: "review", name: "Review", instruction: "", stage: "review" },
  { id: "done", name: "Done", instruction: "", stage: "done" },
  { id: "merged", name: "Merged", instruction: "" },
];
const board = (cards: Board["cards"]): Board => ({ columns: COLS, cards });
const snap = (b: Board) => ({ agents: [], board: b });
const card = (columnId: string) => ({ id: "c1", num: 117, title: "Fix the thing", columnId, assignee: { id: "s1", name: "Dallas" } });

const n = (over: Partial<Notif>): Notif => ({ id: "x", kind: "move", at: 0, who: "", text: "", ...over });

test("a move names the card and the column, never a mover", () => {
  // The assignee is not the mover: the human does most moves and every merge.
  expect(shiftLogText(n({ kind: "move", who: "Dallas", text: "to Review", cardNum: 117 }))).toBe("#117 → REVIEW");
  expect(shiftLogText(n({ kind: "move", who: "", text: "to Done", cardNum: 9 }))).toBe("#9 → DONE");
});

test("a merge reads as MERGED", () => {
  expect(shiftLogText(n({ kind: "move", who: "Kane", text: "to Merged", cardNum: 118, merged: true }))).toBe("#118 MERGED");
});

test("comments and asks carry a short one-line snippet", () => {
  const long = "line one\nline two " + "x".repeat(100);
  const c = shiftLogText(n({ kind: "comment", who: "Kane", text: long, cardNum: 5 }));
  expect(c.startsWith("KANE on #5: line one line two")).toBe(true);
  expect(c.endsWith("…")).toBe(true);
  expect(c.length).toBeLessThan(80);
  expect(shiftLogText(n({ kind: "ask", who: "Ripley", text: "WAITING ON YOU: which port?", cardNum: 120 }))).toBe("RIPLEY asks on #120: which port?");
});

test("a card without a number falls back to its title", () => {
  expect(shiftLogText(n({ kind: "move", who: "Ash", text: "to Review", cardTitle: "Tidy" }))).toBe('"Tidy" → REVIEW');
});

test("clock time is HH:MM, zero-padded, local", () => {
  expect(clockTime(new Date(2026, 8, 24, 9, 5).getTime())).toBe("09:05");
  expect(clockTime(new Date(2026, 8, 24, 14, 32).getTime())).toBe("14:32");
});

test("reduced motion: the newest three, still", () => {
  const items = Array.from({ length: 7 }, (_, i) => n({ id: `e${i}` }));
  const v = shiftLogView(items, true);
  expect(v.scroll).toBe(false);
  expect(v.items.map((i) => i.id)).toEqual(["e0", "e1", "e2"]);
  expect(v.items.length).toBe(SHIFT_LOG_STILL);
});

test("full motion: everything kept, scrolling once there is something to scroll", () => {
  const items = Array.from({ length: 7 }, (_, i) => n({ id: `e${i}` }));
  expect(shiftLogView(items, false)).toEqual({ items, scroll: true });
  expect(shiftLogView([], false).scroll).toBe(false);
});

test("landing in Merged from Done is a merge; reaching Done is not", () => {
  const b = board([]);
  expect(landsMerge(b, "done", "merged")).toBe(true);
  expect(landsMerge(b, "review", "merged")).toBe(true);
  expect(landsMerge(b, "review", "done")).toBe(false);
  expect(landsMerge(b, "backlog", "review")).toBe(false);
});

test("diffNotifications marks a merge and carries the card number", () => {
  const out = diffNotifications(snap(board([card("done")])), snap(board([card("merged")])), "You", 100);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ kind: "move", merged: true, cardNum: 117 });
  const plain = diffNotifications(snap(board([card("in-progress")])), snap(board([card("review")])), "You", 100);
  expect(plain[0]!.merged).toBeUndefined();
  expect(shiftLogText(plain[0]!)).toBe("#117 → REVIEW");
});

test("the feed keeps board events only, newest first, capped", () => {
  expect(isShiftEvent(n({ kind: "needs-you" }))).toBe(false);
  publishShiftLog([n({ id: "need", kind: "needs-you", at: 50 })]);
  expect(shiftLogSnapshot().some((e) => e.id === "need")).toBe(false);
  publishShiftLog([n({ id: "a", at: 1 }), n({ id: "b", at: 2 })]);
  expect(shiftLogSnapshot().slice(0, 2).map((e) => e.id)).toEqual(["b", "a"]);
  publishShiftLog(Array.from({ length: 20 }, (_, i) => n({ id: `z${i}`, at: 10 + i })));
  expect(shiftLogSnapshot()).toHaveLength(SHIFT_LOG_CAP);
  expect(shiftLogSnapshot()[0]!.id).toBe("z19");
});
