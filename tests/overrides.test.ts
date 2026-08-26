import { test, expect } from "bun:test";
import { readOverrides, setNameOverride, applyOverrides } from "../src/lib/overrides";
import type { AgentStatus } from "../src/schema";
import { mkdirSync, rmSync } from "node:fs";

const dir = "/tmp/aw-overrides-test";
function reset() { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }

const A = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "NOVA", role: "r", ticket: null, state: "idle",
  doing: "x", cwd: "/", branch: null, updatedAt: 0, ...o,
});

test("set, read, and apply a name override", () => {
  reset();
  expect(readOverrides(dir)).toEqual({});
  setNameOverride(dir, "sess1", "Captain");
  expect(readOverrides(dir)).toEqual({ sess1: { name: "Captain" } });
  const applied = applyOverrides([A({ sessionId: "sess1", name: "NOVA" }), A({ sessionId: "sess2", name: "VOLT" })], readOverrides(dir));
  expect(applied.find((a) => a.sessionId === "sess1")!.name).toBe("Captain");
  expect(applied.find((a) => a.sessionId === "sess2")!.name).toBe("VOLT");
});

test("clearing a name override removes it", () => {
  reset();
  setNameOverride(dir, "sess1", "Captain");
  setNameOverride(dir, "sess1", "");
  expect(readOverrides(dir).sess1).toBeUndefined();
});

test("readOverrides tolerates a missing/corrupt file", () => {
  reset();
  expect(readOverrides(dir)).toEqual({});
});
