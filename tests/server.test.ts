// tests/server.test.ts
import { test, expect } from "bun:test";
import { readSnapshot } from "../src/server";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = "/tmp/aw-server-test";

function reset() { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }

const valid = (o: object) => JSON.stringify({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 9_999_999_999_999, ...o,
});

test("readSnapshot includes valid, skips invalid", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", ticket: "#1" }));
  writeFileSync(join(dir, "b.json"), valid({ sessionId: "b", ticket: "#2" }));
  writeFileSync(join(dir, "bad.json"), "{ not json");
  const snap = readSnapshot(dir, Date.now());
  expect(snap.agents.map((a) => a.sessionId).sort()).toEqual(["a", "b"]);
});

test("readSnapshot on empty dir -> empty agents", () => {
  reset();
  expect(readSnapshot(dir, Date.now()).agents).toEqual([]);
});

test("GET /events streams a snapshot", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", ticket: "#9" }));
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text.startsWith("data: ")).toBe(true);
  expect(text).toContain('"#9"');
  await reader.cancel();
  server.stop(true);
});

test("scan:true runs a pass and stop() cleans up without leaking a timer", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  // point the scanner at an empty projects dir so it doesn't touch ~/.claude
  const empty = "/tmp/aw-server-test-empty-projects";
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty, { recursive: true });
  process.env.AGENT_PROJECTS_DIR = empty;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { scan: true, scanIntervalMs: 50 });
  // let the initial async scan + interval run a few times
  await new Promise((r) => setTimeout(r, 160));
  server.stop(true); // must clear the scan interval; if it didn't, the test process would hang
  // a scan over an empty projects dir writes nothing
  expect(readSnapshot(dir, Date.now()).agents).toEqual([]);
});
