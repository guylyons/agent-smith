// tests/useSnapshot.test.ts
import { test, expect } from "bun:test";
import { parseEvent, emptySnapshot } from "../src/ui/useSnapshot";

test("emptySnapshot has five stages, no agents", () => {
  const s = emptySnapshot();
  expect(s.agents).toEqual([]);
  expect(s.line.map((l) => l.stage)).toEqual(["backlog","working","needs","review","merged"]);
});
test("parseEvent parses a snapshot", () => {
  const snap = emptySnapshot();
  expect(parseEvent(JSON.stringify(snap))?.agents).toEqual([]);
});
test("parseEvent returns null on garbage", () => {
  expect(parseEvent("{bad")).toBeNull();
});
