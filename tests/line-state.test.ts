import { test, expect } from "bun:test";
import { readLineState, setLineStage } from "../src/lib/line-state";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

test("readLineState drops malformed entries so a bad file can't crash the snapshot", () => {
  reset();
  writeFileSync(join(dir, ".line.json"), JSON.stringify({
    "repo|good": { stage: "review", label: "#7", sessionId: "s1" },
    "repo|badstage": { stage: "archived", label: "#8" }, // unknown stage
    "repo|nolabel": { stage: "merged" },                 // missing label
    "repo|notobj": "nope",
  }));
  expect(readLineState(dir)).toEqual({ "repo|good": { stage: "review", label: "#7", sessionId: "s1" } });
});

test("readLineState rejects a JSON array as the state map", () => {
  reset();
  writeFileSync(join(dir, ".line.json"), JSON.stringify([1, 2, 3]));
  expect(readLineState(dir)).toEqual({});
});
