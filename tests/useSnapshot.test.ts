// tests/useSnapshot.test.ts
import { test, expect } from "bun:test";
import { parseEvent, emptySnapshot, isFatalDrop, applyEvent } from "../src/ui/useSnapshot";

test("emptySnapshot has no agents and an empty board", () => {
  const s = emptySnapshot();
  expect(s.agents).toEqual([]);
  expect(s.board.columns).toEqual([]);
  expect(s.board.cards).toEqual([]);
});
test("parseEvent parses a snapshot", () => {
  const snap = emptySnapshot();
  expect(parseEvent(JSON.stringify(snap))?.agents).toEqual([]);
});
test("parseEvent returns null on garbage", () => {
  expect(parseEvent("{bad")).toBeNull();
});

test("only a CLOSED EventSource counts as a fatal drop worth rebuilding", () => {
  expect(isFatalDrop(0)).toBe(false); // CONNECTING — it is retrying on its own
  expect(isFatalDrop(1)).toBe(false); // OPEN — a blip, not a drop
  expect(isFatalDrop(2)).toBe(true);  // CLOSED — it has given up; we reconnect
});

test("applyEvent keeps the board and mood a push left out", () => {
  const prev = { ...emptySnapshot(), board: { columns: [{ id: "k", name: "K", instruction: "" }], cards: [] }, mood: { notes: [], links: [] } as any, archived: 3 };
  const next = applyEvent(prev, { agents: [{ sessionId: "a" } as any], archived: 4 });
  expect(next.agents.length).toBe(1);
  expect(next.board).toBe(prev.board);
  expect(next.mood).toBe(prev.mood);
  expect(next.archived).toBe(4);
  const replaced = applyEvent(prev, { agents: [], board: { columns: [], cards: [] } });
  expect(replaced.board.columns).toEqual([]);
});
