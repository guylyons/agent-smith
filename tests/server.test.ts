// tests/server.test.ts
import { test, expect } from "bun:test";
import { readSnapshot } from "../src/server";
import { setNameOverride } from "../src/lib/overrides";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

test("POST /action/line-stage designates an item, visible in the snapshot", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/action/line-stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "repo|#9", stage: "review", label: "#9", sessionId: "s1" }),
  });
  expect((await res.json()).ok).toBe(true);
  const review = readSnapshot(dir, Date.now()).line.find((s) => s.stage === "review")!;
  expect(review.items.map((i) => i.label)).toEqual(["#9"]);
  server.stop(true);
});

test("POST /action/line-stage with a non-designation stage clears it", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const post = (stage: string) => fetch(`http://localhost:${server.port}/action/line-stage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "repo|#9", stage, label: "#9" }),
  });
  await post("review");
  await post("done"); // moving back off review/merged clears the designation
  const merged = readSnapshot(dir, Date.now()).line;
  expect(merged.flatMap((s) => s.items)).toEqual([]);
  server.stop(true);
});

test("POST /action/upload saves an image and returns its path", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  process.env.AGENT_UPLOAD_DIR = "/tmp/aw-server-upload-test";
  rmSync("/tmp/aw-server-upload-test", { recursive: true, force: true });
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/action/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "shot.png", type: "image/png", dataBase64: Buffer.from("PNG").toString("base64") }),
  });
  const out = (await res.json()) as { ok: boolean; path?: string };
  expect(out.ok).toBe(true);
  expect(out.path!.startsWith("/tmp/aw-server-upload-test/")).toBe(true);
  expect(readFileSync(out.path!, "utf8")).toBe("PNG");
  server.stop(true);
});

test("POST /action/upload rejects a non-image type", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/action/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x.svg", type: "image/svg+xml", dataBase64: Buffer.from("<svg>").toString("base64") }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).ok).toBe(false);
  server.stop(true);
});

test("GET /personas lists the built-ins without prompt text", async () => {
  const { makeServer } = await import("../src/server");
  const srv = makeServer(0, { scan: false });
  const res = await fetch(`http://localhost:${srv.port}/personas`);
  expect(res.status).toBe(200);
  const list = (await res.json()) as any[];
  expect(list.map((p) => p.id)).toEqual(["backend-dev", "editor", "frontend-ux", "scrum-master"]);
  expect(list[0].name).toBeTruthy();
  expect(list[0].role).toBeTruthy();
  expect(Array.isArray(list[0].skills)).toBe(true);
  expect(list[0].prompt).toBeUndefined();
  srv.stop();
});

test("readSnapshot resolves a persona onto the agent", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", persona: "backend-dev", name: "NOVA", role: "General" }));
  const [agent] = readSnapshot(dir, Date.now()).agents;
  expect(agent.name).toBe("ANVIL");
  expect(agent.role).toBe("Backend Dev");
  expect(agent.sprite!.body).toBe("robot");
});

test("readSnapshot leaves a persona-less agent alone", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", name: "NOVA", role: "General" }));
  expect(readSnapshot(dir, Date.now()).agents[0].name).toBe("NOVA");
});

test("readSnapshot: a name override on a persona'd agent wins the name but not the role", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", persona: "backend-dev", name: "NOVA", role: "General" }));
  setNameOverride(dir, "a", "CUSTOM-NAME");
  const [agent] = readSnapshot(dir, Date.now()).agents;
  expect(agent.name).toBe("CUSTOM-NAME");
  expect(agent.name).not.toBe("ANVIL");
  expect(agent.role).toBe("Backend Dev");
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
