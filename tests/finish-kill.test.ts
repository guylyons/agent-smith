import { test, expect } from "bun:test";
import { defaultBoard, addColumn, finishesCard } from "../src/lib/board";
import { finishedAssignees } from "../src/ui/soundEvents";
import type { Board } from "../src/lib/board";

// A stock board plus a stageless "Merged" after Done (a landed column).
const board = (): Board => addColumn(defaultBoard(), "Merged");
const merged = (b: Board) => b.columns[4]!.id;

test("finishesCard: entering Done from before it finishes the card", () => {
  const b = board();
  expect(finishesCard(b, "review", "done")).toBe(true);
  expect(finishesCard(b, "in-progress", "done")).toBe(true);
  expect(finishesCard(b, "backlog", "done")).toBe(true);
});

test("finishesCard: jumping straight to a column after Done (a merge) finishes it too", () => {
  const b = board();
  expect(finishesCard(b, "review", merged(b))).toBe(true);
});

test("finishesCard: moving within or past the finished columns does not finish it again", () => {
  const b = board();
  expect(finishesCard(b, "done", merged(b))).toBe(false);
  expect(finishesCard(b, "done", "done")).toBe(false);
  expect(finishesCard(b, merged(b), "done")).toBe(false);
});

test("finishesCard: moves that stay before Done, or go back, don't finish", () => {
  const b = board();
  expect(finishesCard(b, "in-progress", "review")).toBe(false);
  expect(finishesCard(b, "done", "review")).toBe(false);
});

test("finishesCard: unknown columns never finish", () => {
  const b = board();
  expect(finishesCard(b, "review", "nope")).toBe(false);
});

const agent = (sessionId: string, crew?: string) => ({ sessionId, crew: crew ? { id: crew, name: "X" } : undefined });

test("finishedAssignees: the live session of each card moved into Done", () => {
  const b = board();
  const assignee = { id: "sess-1", name: "SULACO" };
  const snap: Board = {
    ...b,
    cards: [
      { id: "c1", title: "a", columnId: "done", assignee },
      { id: "c2", title: "b", columnId: "done" },
      { id: "c3", title: "c", columnId: "review", assignee: { ...assignee, id: "sess-3" } },
      { id: "c4", title: "d", columnId: "done", assignee: { id: "gone", name: "Y" } },
    ],
  };
  const moves = [
    { cardId: "c1", title: "a", from: "review", to: "done" },
    { cardId: "c2", title: "b", from: "review", to: "done" }, // no assignee
    { cardId: "c3", title: "c", from: "in-progress", to: "review" }, // not finishing
    { cardId: "c4", title: "d", from: "review", to: "done" }, // assignee not live
  ];
  expect(finishedAssignees(moves, snap, [agent("sess-1"), agent("sess-3")])).toEqual(["sess-1"]);
});

test("finishedAssignees: follows the crew to its current session after a /clear", () => {
  const b = board();
  const snap: Board = { ...b, cards: [{ id: "c1", title: "a", columnId: "done", assignee: { id: "old", name: "S", crew: "sulaco-6f7b" } }] };
  const moves = [{ cardId: "c1", title: "a", from: "review", to: "done" }];
  expect(finishedAssignees(moves, snap, [agent("new", "sulaco-6f7b")])).toEqual(["new"]);
});
