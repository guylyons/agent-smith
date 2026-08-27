import { test, expect } from "bun:test";
import { readLineState, setLineStage } from "../src/lib/line-state";
import { mkdirSync, rmSync } from "node:fs";

const dir = "/tmp/aw-line-state-test";
function reset() { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }

test("set, read, and clear a designation", () => {
  reset();
  expect(readLineState(dir)).toEqual({});

  setLineStage(dir, "agentsmith|#12", { stage: "review", label: "#12", sessionId: "s1" });
  expect(readLineState(dir)).toEqual({ "agentsmith|#12": { stage: "review", label: "#12", sessionId: "s1" } });

  setLineStage(dir, "agentsmith|#12", { stage: "merged", label: "#12", sessionId: "s1" });
  expect(readLineState(dir)["agentsmith|#12"]!.stage).toBe("merged");

  setLineStage(dir, "agentsmith|#12", null); // clear
  expect(readLineState(dir)["agentsmith|#12"]).toBeUndefined();
});

test("readLineState tolerates a missing/corrupt file", () => {
  reset();
  expect(readLineState(dir)).toEqual({});
});
