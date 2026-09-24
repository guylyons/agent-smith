import { test, expect } from "bun:test";
import { inStateFor, isStaleIdle, STALE_IDLE_MS } from "../src/ui/inState";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test("inStateFor: <1m, minutes, hours, days", () => {
  expect(inStateFor(NOW - 10_000, NOW)).toBe("<1m");
  expect(inStateFor(NOW - 12 * MIN, NOW)).toBe("12m");
  expect(inStateFor(NOW - 3 * 60 * MIN, NOW)).toBe("3h");
  expect(inStateFor(NOW - 2 * 24 * 60 * MIN, NOW)).toBe("2d");
});

test("inStateFor: boundaries round down", () => {
  expect(inStateFor(NOW - 59 * MIN, NOW)).toBe("59m");
  expect(inStateFor(NOW - 60 * MIN, NOW)).toBe("1h");
  expect(inStateFor(NOW - 24 * 60 * MIN, NOW)).toBe("1d");
});

test("inStateFor: missing stateSince is empty", () => {
  expect(inStateFor(undefined, NOW)).toBe("");
  expect(inStateFor(0, NOW)).toBe("");
});

test("isStaleIdle: only idle past STALE_IDLE_MS", () => {
  expect(isStaleIdle({ state: "idle", stateSince: NOW - 3 * 60 * MIN }, NOW)).toBe(true);
  expect(isStaleIdle({ state: "idle", stateSince: NOW - STALE_IDLE_MS }, NOW)).toBe(false);
  expect(isStaleIdle({ state: "idle", stateSince: NOW }, NOW)).toBe(false);
  expect(isStaleIdle({ state: "waiting", stateSince: NOW - 40 * 60 * MIN }, NOW)).toBe(false);
  expect(isStaleIdle({ state: "working", stateSince: NOW - 40 * 60 * MIN }, NOW)).toBe(false);
  expect(isStaleIdle({ state: "idle" }, NOW)).toBe(false);
});
