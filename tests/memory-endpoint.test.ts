// tests/memory-endpoint.test.ts — the team memory over HTTP: record a fact,
// search it alongside the board's cards, forget it, and never overwrite a
// memory file that can't be read.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { fixtureDir } from "./fixtures";
import { writeBoard, type Board } from "../src/lib/board";
import { memoryFile } from "../src/lib/memory";

const dir = fixtureDir("memory-endpoint");

const BOARD: Board = {
  columns: [{ id: "merged", name: "Merged", instruction: "" }],
  cards: [{ id: "card_m1", title: "Lock the merge queue", columnId: "merged", repo: "agent-smith", touches: ["src/lib/merge.ts"] }],
};

async function start() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  writeBoard(dir, BOARD);
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { quit: async () => ({ ok: true }) });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { server, base, post };
}

test("memory-add stores a fact that GET /memory finds, next to the cards", async () => {
  const { server, base, post } = await start();
  const res = await post("/action/memory-add", {
    kind: "decision", title: "One merge at a time", body: "Races corrupted the queue.",
    links: ["repo:agent-smith", "file:src/lib/merge.ts", "card_m1"], author: "DALLAS",
  });
  expect(res.status).toBe(200);
  const added = (await res.json()) as { ok: boolean; node: { id: string } };
  expect(added.ok).toBe(true);
  expect(added.node.id).toMatch(/^mem_/);
  expect(JSON.parse(readFileSync(memoryFile(dir), "utf8")).nodes).toHaveLength(1);

  const found = (await (await fetch(`${base}/memory?q=${encodeURIComponent("file:src/lib/merge.ts")}`)).json()) as { results: any[] };
  expect(found.results.map((n) => n.title).sort()).toEqual(["Lock the merge queue", "One merge at a time"]);
  expect(found.results.find((n) => n.kind === "decision").by).toBe("DALLAS");

  const text = await (await fetch(`${base}/memory?q=kind:decision&format=text`)).text();
  expect(text).toContain("One merge at a time");
  expect(text).not.toContain("Lock the merge queue");
  server.stop(true);
});

test("memory-add refuses a bad kind or blank title and writes nothing", async () => {
  const { server, post } = await start();
  const bad = await post("/action/memory-add", { kind: "wish", title: "x" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).error).toMatch(/kind/);
  const blank = await post("/action/memory-add", { kind: "note", title: " " });
  expect(blank.status).toBe(400);
  expect(() => readFileSync(memoryFile(dir), "utf8")).toThrow();
  server.stop(true);
});

test("memory-forget removes a fact; an unknown id is a 404", async () => {
  const { server, base, post } = await start();
  const { node } = (await (await post("/action/memory-add", { kind: "note", title: "temp" })).json()) as any;
  expect((await post("/action/memory-forget", { id: node.id })).status).toBe(200);
  const after = (await (await fetch(`${base}/memory?q=kind:note`)).json()) as { results: any[] };
  expect(after.results).toEqual([]);
  expect((await post("/action/memory-forget", { id: node.id })).status).toBe(404);
  server.stop(true);
});

test("a corrupt memory file is never overwritten by a write", async () => {
  const { server, base, post } = await start();
  writeFileSync(memoryFile(dir), "{broken");
  const res = await post("/action/memory-add", { kind: "note", title: "x" });
  expect(res.status).toBe(500);
  expect(readFileSync(memoryFile(dir), "utf8")).toBe("{broken");
  // reads still work, showing the cards
  const found = (await (await fetch(`${base}/memory`)).json()) as { results: any[] };
  expect(found.results.map((n) => n.id)).toEqual(["card:card_m1"]);
  server.stop(true);
});

test("GET /memory?id= returns a node and its neighbours", async () => {
  const { server, base, post } = await start();
  const { node } = (await (await post("/action/memory-add", { kind: "gotcha", title: "Watch the lock", links: ["card_m1"] })).json()) as any;
  const res = await fetch(`${base}/memory?id=card:card_m1`);
  const body = (await res.json()) as { node: any; neighbours: any[] };
  expect(body.node.title).toBe("Lock the merge queue");
  expect(body.neighbours.map((n) => n.id)).toEqual([node.id]);
  expect((await fetch(`${base}/memory?id=mem_00000000`)).status).toBe(404);
  server.stop(true);
});
