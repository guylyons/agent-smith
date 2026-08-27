// tests/useSnapshot.test.ts
import { test, expect } from "bun:test";
import { parseEvent, emptySnapshot } from "../src/ui/useSnapshot";

test("emptySnapshot has the six lifecycle stages, no agents", () => {
  const s = emptySnapshot();
  expect(s.agents).toEqual([]);
  expect(s.line.map((l) => l.stage)).toEqual(["backlog","working","needs","done","review","merged"]);
  expect(s.line.every((l) => Array.isArray(l.items) && l.items.length === 0)).toBe(true);
});
test("parseEvent parses a snapshot", () => {
  const snap = emptySnapshot();
  expect(parseEvent(JSON.stringify(snap))?.agents).toEqual([]);
});
test("parseEvent returns null on garbage", () => {
  expect(parseEvent("{bad")).toBeNull();
});
