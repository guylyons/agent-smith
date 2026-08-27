// tests/useSnapshot.test.ts
import { test, expect } from "bun:test";
import { parseEvent, emptySnapshot } from "../src/ui/useSnapshot";

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
