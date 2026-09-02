import { test, expect } from "bun:test";
import { isActivelyWorking, displayState, WORKING_FRESH_MS } from "../src/lib/liveness";
import type { AgentStatus } from "../src/schema";

const NOW = 1_700_000_000_000;
function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    sessionId: "s1", name: "RIPLEY", role: "General", state: "working",
    doing: "thinking", cwd: "/tmp", branch: null, updatedAt: NOW,
    ...over,
  } as AgentStatus;
}

test("a freshly-stamped working agent is actively working", () => {
  expect(isActivelyWorking(agent({ updatedAt: NOW - 5_000 }), NOW)).toBe(true);
});

test("a working status nobody has refreshed lately is not believed", () => {
  expect(isActivelyWorking(agent({ updatedAt: NOW - WORKING_FRESH_MS - 1 }), NOW)).toBe(false);
});

test("the freshness window is generous next to the 20s scan cadence", () => {
  // four scan passes of headroom, so a real worker can never fall out of it
  expect(WORKING_FRESH_MS).toBeGreaterThanOrEqual(80_000);
});

test("idle and waiting are never actively working, however fresh", () => {
  expect(isActivelyWorking(agent({ state: "idle" }), NOW)).toBe(false);
  expect(isActivelyWorking(agent({ state: "waiting" }), NOW)).toBe(false);
});

test("a session blocked on the user is not working, even if it says working", () => {
  // the hook pins waitingReason; a scan pass can re-derive the state as working
  // off an unresolved tool_use, and that must not read as motion
  expect(isActivelyWorking(agent({ waitingReason: "permission" }), NOW)).toBe(false);
});

test("a status with no usable timestamp is not vouched for", () => {
  expect(isActivelyWorking(agent({ updatedAt: undefined as unknown as number }), NOW)).toBe(false);
  expect(isActivelyWorking(agent({ updatedAt: Number.NaN }), NOW)).toBe(false);
});

test("a clock running slightly ahead is not punished", () => {
  expect(isActivelyWorking(agent({ updatedAt: NOW + 2_000 }), NOW)).toBe(true);
});

test("displayState downgrades a stale worker to idle and leaves everything else alone", () => {
  expect(displayState(agent({ updatedAt: NOW - 1_000 }), NOW)).toBe("working");
  expect(displayState(agent({ updatedAt: NOW - 10 * 60_000 }), NOW)).toBe("idle");
  expect(displayState(agent({ state: "waiting", updatedAt: NOW - 10 * 60_000 }), NOW)).toBe("waiting");
  expect(displayState(agent({ state: "idle" }), NOW)).toBe("idle");
});

test("the window is overridable so a caller can tighten or loosen it", () => {
  const a = agent({ updatedAt: NOW - 30_000 });
  expect(isActivelyWorking(a, NOW, 10_000)).toBe(false);
  expect(isActivelyWorking(a, NOW, 60_000)).toBe(true);
});
