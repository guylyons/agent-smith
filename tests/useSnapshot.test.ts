// tests/useSnapshot.test.ts
import { test, expect } from "bun:test";
import { parseEvent, emptySnapshot, isFatalDrop } from "../src/ui/useSnapshot";

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
