// tests/spawn-assign.test.ts — "new agent for this card" binds the card to the
// session it spawned even when hooks are not installed. The server records the
// (card -> spawn) intent at /action/spawn and applies it once the new session
// shows up, matched by something the spawn controls: the crew id it minted, or
// the fresh worktree it created. Never by guessing.
import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { readSnapshot } from "../src/server";
import { matchPendingSpawns, sessionsNeedingOpeningPrompt, PENDING_SPAWN_TTL_MS, type PendingSpawn } from "../src/lib/spawnAssign";
import type { AgentStatus } from "../src/schema";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const NEW = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OLD = "11111111-2222-4333-8444-555555555555";
const WT = "/repo/.claude/worktrees/fix-thing";

const agent = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: NEW, name: "A", role: "r", ticket: null, state: "working",
  doing: "x", cwd: WT, branch: "b", updatedAt: Date.now(), ...o,
});

const spawn = (o: Partial<PendingSpawn> = {}): PendingSpawn => ({
  cardId: "card_1", cwd: WT, uniqueCwd: true, crewId: "volt-1a2b", task: "do the card",
  before: [], at: 1_000, force: false, ...o,
});

// ---- the pure matcher -----------------------------------------------------

test("a session carrying the spawn's crew id is its session (hooks installed)", () => {
  const r = matchPendingSpawns([spawn({ cwd: "/elsewhere" })], [agent({ crew: { id: "volt-1a2b", name: "VOLT" } })], 2_000);
  expect(r.matches.map((m) => [m.spawn.cardId, m.sessionId])).toEqual([["card_1", NEW]]);
  expect(r.keep).toEqual([]);
});

test("with no hooks, the one new session in the spawn's fresh worktree is its session", () => {
  const r = matchPendingSpawns([spawn()], [agent({})], 2_000);
  expect(r.matches.map((m) => m.sessionId)).toEqual([NEW]);
});

test("a session that was already live at spawn time is never taken", () => {
  const r = matchPendingSpawns([spawn({ before: [OLD] })], [agent({ sessionId: OLD })], 2_000);
  expect(r.matches).toEqual([]);
  expect(r.keep.length).toBe(1);
});

test("a session with a different crew id is someone else, even in the same folder", () => {
  const r = matchPendingSpawns([spawn()], [agent({ crew: { id: "ember-9f9f", name: "EMBER" } })], 2_000);
  expect(r.matches).toEqual([]);
});

test("two new sessions in the worktree is ambiguous: wait, don't guess", () => {
  const r = matchPendingSpawns([spawn()], [agent({}), agent({ sessionId: OLD })], 2_000);
  expect(r.matches).toEqual([]);
  expect(r.keep.length).toBe(1);
});

test("in a shared folder, cwd alone is not enough: the opening prompt must be the task", () => {
  const p = spawn({ uniqueCwd: false, cwd: "/repo" });
  const a = agent({ cwd: "/repo" });
  expect(matchPendingSpawns([p], [a], 2_000).matches).toEqual([]);
  expect(sessionsNeedingOpeningPrompt([p], [a])).toEqual([NEW]);
  const wrong = matchPendingSpawns([p], [a], 2_000, new Map([[NEW, "something else"]]));
  expect(wrong.matches).toEqual([]);
  const right = matchPendingSpawns([p], [a], 2_000, new Map([[NEW, "  do the card\n"]]));
  expect(right.matches.map((m) => m.sessionId)).toEqual([NEW]);
});

test("one session never satisfies two spawns", () => {
  const r = matchPendingSpawns([spawn({ cardId: "card_1" }), spawn({ cardId: "card_2", crewId: "ember-9f9f" })], [agent({})], 2_000);
  expect(r.matches.length).toBe(0); // both claim the same fresh cwd: ambiguous
  const byCrew = matchPendingSpawns(
    [spawn({ cardId: "card_1" }), spawn({ cardId: "card_2", crewId: "ember-9f9f" })],
    [agent({ crew: { id: "ember-9f9f", name: "EMBER" } })], 2_000,
  );
  expect(byCrew.matches.map((m) => m.spawn.cardId)).toEqual(["card_2"]);
});

test("an intent nobody picked up expires", () => {
  const r = matchPendingSpawns([spawn({ at: 0 })], [], PENDING_SPAWN_TTL_MS + 1);
  expect(r.keep).toEqual([]);
  expect(r.matches).toEqual([]);
});

// ---- over HTTP ------------------------------------------------------------

const dir = fixtureDir("spawn-assign-test");
const wt = join(dir, "wt");

const status = (o: object) => JSON.stringify({
  sessionId: NEW, name: "A", role: "r", ticket: null, state: "working",
  doing: "x", cwd: wt, branch: "b", updatedAt: Date.now(), ...o,
});

async function server() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(wt, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const spawned: { cwd: string; cardId?: string }[] = [];
  const modes: (string | undefined)[] = [];
  const srv = makeServer(0, {
    // Stands in for Ghostty: "launches" into a fresh worktree at `wt`.
    spawn: async (_cwd, _task, opts) => {
      spawned.push({ cwd: wt, cardId: opts?.cardId });
      modes.push(opts?.permissionMode);
      return { ok: true, cwd: wt, worktreeCreated: true };
    },
  });
  const base = `http://localhost:${srv.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const add = async (title: string) =>
    ((await (await post("/action/card-add", { columnId: "backlog", title })).json()) as any).cardId as string;
  const card = (id: string) => readSnapshot(dir, Date.now()).board.cards.find((k) => k.id === id)!;
  return { srv, base, post, add, card, spawned, modes };
}

/** Wait for the status-dir watcher (150ms debounce) to push, and for the
 *  pending-spawn pass it triggers to land. */
async function until(cond: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

test("no hooks: the card is assigned to the new session once its status file appears", async () => {
  const { srv, post, add, card, spawned } = await server();
  const id = await add("Fix the thing");
  const res = await post("/action/spawn", { cwd: dir, text: "do the card", cardId: id });
  expect(((await res.json()) as any).ok).toBe(true);
  expect(spawned).toEqual([{ cwd: wt, cardId: id }]);
  expect(card(id).assignee).toBeFalsy();
  // What the scanner writes for a session without hooks: no crew, no pid.
  writeFileSync(join(dir, `${NEW}.json`), status({}));
  await until(() => !!card(id).assignee);
  expect(card(id).assignee?.id).toBe(NEW);
  srv.stop(true);
});

test("a hook's card-assign settles the intent: the server never assigns on top of it", async () => {
  const { srv, post, add, card } = await server();
  const id = await add("Fix the thing");
  await post("/action/spawn", { cwd: dir, text: "do the card", cardId: id });
  writeFileSync(join(dir, `${OLD}.json`), status({ sessionId: OLD, cwd: "/somewhere/else" }));
  // The hook got there first...
  expect(((await (await post("/action/card-assign", { cardId: id, sessionId: OLD })).json()) as any).ok).toBe(true);
  // ...so a later matching session must not steal the card back.
  writeFileSync(join(dir, `${NEW}.json`), status({}));
  await new Promise((r) => setTimeout(r, 600));
  expect(card(id).assignee?.id).toBe(OLD);
  srv.stop(true);
});

test("the file-claim gate still applies when the intent lands", async () => {
  const { srv, post, add, card } = await server();
  const first = await add("First");
  const second = await add("Second");
  await post("/action/spawn", { cwd: dir, text: "do the card", cardId: second });
  // After the spawn, another card claims an overlapping file and gets staffed.
  writeFileSync(join(dir, `${OLD}.json`), status({ sessionId: OLD, cwd: "/somewhere/else" }));
  await post("/action/card-update", { cardId: first, touches: ["src/a.ts"] });
  await post("/action/card-assign", { cardId: first, sessionId: OLD });
  await post("/action/card-move", { cardId: first, toColumnId: "in-progress", author: "VOLT" });
  await post("/action/card-update", { cardId: second, touches: ["src/a.ts"] });
  writeFileSync(join(dir, `${NEW}.json`), status({}));
  await new Promise((r) => setTimeout(r, 600));
  expect(card(second).assignee).toBeFalsy();
  srv.stop(true);
});

test("a forced spawn is past the gate when its intent lands too", async () => {
  const { srv, post, add, card } = await server();
  const first = await add("First");
  const second = await add("Second");
  writeFileSync(join(dir, `${OLD}.json`), status({ sessionId: OLD, cwd: "/somewhere/else" }));
  await post("/action/card-update", { cardId: first, touches: ["src/a.ts"] });
  await post("/action/card-assign", { cardId: first, sessionId: OLD });
  await post("/action/card-move", { cardId: first, toColumnId: "in-progress", author: "VOLT" });
  await post("/action/card-update", { cardId: second, touches: ["src/a.ts"] });
  await post("/action/spawn", { cwd: dir, text: "do the card", cardId: second, force: true });
  writeFileSync(join(dir, `${NEW}.json`), status({}));
  await until(() => !!card(second).assignee);
  expect(card(second).assignee?.id).toBe(NEW);
  srv.stop(true);
});

// ---- the permission mode an agent-spawned worker runs in ---------------------
// A scrum master staffs cards by spawning; its workers run in auto mode unless
// it names a mode. A human in the dialog gets exactly what they picked.

test("an agent's spawn with no mode launches the worker in auto mode", async () => {
  const { srv, post, add, modes } = await server();
  await post("/action/spawn", { cwd: dir, text: "do the card", cardId: await add("T") });
  expect(modes).toEqual(["auto"]);
  srv.stop(true);
});

test("an agent's spawn keeps a mode it names", async () => {
  const { srv, post, modes } = await server();
  await post("/action/spawn", { cwd: dir, text: "t", permissionMode: "plan" });
  expect(modes).toEqual(["plan"]);
  srv.stop(true);
});

test("a spawn from the dashboard with no mode stays on Claude's default", async () => {
  const { srv, base, modes } = await server();
  await fetch(`${base}/action/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ cwd: dir, text: "t" }),
  });
  expect(modes).toEqual([undefined]);
  srv.stop(true);
});
