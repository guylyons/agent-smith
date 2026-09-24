// tests/server.test.ts
import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { readSnapshot } from "../src/server";
import { setNameOverride } from "../src/lib/overrides";
import { markWorktreeOwned } from "../src/lib/worktree";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

const dir = fixtureDir("server-test");

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

test("POST /action/board no longer overwrites the board", async () => {
  // The whole-board write was removed: a writer holding a stale board would
  // silently erase whatever landed since it read. Neither a scripted client
  // (curl sends no sec-fetch-site) nor the page itself may call it.
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`http://localhost:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  expect((await (await post("/action/column-add", { name: "Keep me" })).json()).ok).toBe(true);
  const before = readSnapshot(dir, Date.now()).board;
  const clobber = { columns: [{ id: "c1", name: "Clobbered", instruction: "" }], cards: [] };
  for (const headers of [{}, { "sec-fetch-site": "same-origin" }] as Record<string, string>[]) {
    const res = await post("/action/board", { board: clobber }, headers);
    expect(res.ok).toBe(false);
    expect((await res.json()).ok).toBe(false);
  }
  expect(readSnapshot(dir, Date.now()).board).toEqual(before);
  server.stop(true);
});

test("POST /action/upload saves an image and returns its path", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const uploads = fixtureDir("server-upload-test");
  process.env.AGENT_UPLOAD_DIR = uploads;
  rmSync(uploads, { recursive: true, force: true });
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/action/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "shot.png", type: "image/png", dataBase64: Buffer.from("PNG").toString("base64") }),
  });
  const out = (await res.json()) as { ok: boolean; path?: string };
  expect(out.ok).toBe(true);
  expect(out.path!.startsWith(`${uploads}/`)).toBe(true);
  expect(readFileSync(out.path!, "utf8")).toBe("PNG");
  server.stop(true);
});

test("GET /uploads serves a saved image back, and refuses a traversal", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const uploads = fixtureDir("server-upload-serve-test");
  process.env.AGENT_UPLOAD_DIR = uploads;
  rmSync(uploads, { recursive: true, force: true });
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const saved = await fetch(`http://localhost:${server.port}/action/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "shot.png", type: "image/png", dataBase64: Buffer.from("PNGBYTES").toString("base64") }),
  });
  const out = (await saved.json()) as { ok: boolean; url?: string };
  expect(out.ok).toBe(true);
  expect(out.url!.startsWith("/uploads/")).toBe(true);

  // the URL the browser is handed round-trips to the file's bytes
  const got = await fetch(`http://localhost:${server.port}${out.url}`);
  expect(got.status).toBe(200);
  expect(await got.text()).toBe("PNGBYTES");

  // and the route can't be walked out of the upload dir
  for (const bad of ["/uploads/../../etc/passwd", "/uploads/..%2f..%2fetc%2fpasswd", "/uploads/nope.png"]) {
    expect((await fetch(`http://localhost:${server.port}${bad}`)).status).toBe(404);
  }
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

test("POST /action/rename rejects a non-string name with 400 (not a 500)", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/action/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "abc", name: 42 }),
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
  expect(list.map((p) => p.id)).toEqual(["backend-dev", "editor", "frontend-ux", "release-manager", "scrum-master"]);
  expect(list[0].name).toBe("VASQUEZ"); // each role has its own crew member
  expect(list.find((p) => p.id === "editor").model).toBe("sonnet");
  expect(list[0].role).toBeTruthy();
  expect(Array.isArray(list[0].skills)).toBe(true);
  expect(list[0].prompt).toBeUndefined();
  srv.stop();
});

test("readSnapshot resolves a persona onto the agent", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", persona: "backend-dev", name: "NOVA", role: "General" }));
  const [agent] = readSnapshot(dir, Date.now()).agents;
  expect(agent.name).toBe("VASQUEZ"); // the persona's own name
  expect(agent.role).toBe("Backend Dev");
  expect(agent.sprite?.body).toBe("vasquez"); // and its own look
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
  // Its OWN status dir: a scan pass (ps, lsof, osascript) can outlive stop(),
  // and its cleanup deletes pid-less status files — which would wipe the agents
  // a later test writes into the shared dir, minutes of confusion later.
  const scanDir = fixtureDir("server-test-scan");
  rmSync(scanDir, { recursive: true, force: true });
  mkdirSync(scanDir, { recursive: true });
  process.env.AGENT_STATUS_DIR = scanDir;
  // point the scanner at an empty projects dir so it doesn't touch ~/.claude
  const empty = fixtureDir("server-test-empty-projects");
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty, { recursive: true });
  process.env.AGENT_PROJECTS_DIR = empty;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { scan: true, scanIntervalMs: 50 });
  // let the initial async scan + interval run a few times
  await new Promise((r) => setTimeout(r, 160));
  server.stop(true); // must clear the scan interval; if it didn't, the test process would hang
  // a scan over an empty projects dir writes nothing
  expect(readSnapshot(scanDir, Date.now()).agents).toEqual([]);
  process.env.AGENT_STATUS_DIR = dir;
});

// ---- the card-scoped agent API -------------------------------------------
// Agents drive their own ticket through these; each is applied server-side
// against the latest board, so concurrent writers never clobber each other.

const CARD_SESSION = "502d0e8c-8790-4804-b767-0549edfc959c";

async function cardApiServer(opts: Parameters<typeof import("../src/server").makeServer>[1] = {}) {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  // A merge ends the assignee's session; never let a test close a real tab.
  const server = makeServer(0, { quit: async () => ({ ok: true }), ...opts });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { server, base, post };
}

test("GET /board returns the current board and its path", async () => {
  const { server, base, post } = await cardApiServer();
  await post("/action/card-add", { columnId: "backlog", title: "T1" });
  const res = await fetch(`${base}/board`);
  expect(res.status).toBe(200);
  const out = (await res.json()) as { board: { cards: any[] }; boardPath: string };
  expect(out.board.cards.map((c) => c.title)).toEqual(["T1"]);
  expect(out.boardPath.endsWith(".line.json")).toBe(true);
  server.stop(true);
});

test("GET /agents lists live sessions with resolved names", async () => {
  const { server, base } = await cardApiServer();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", persona: "backend-dev" }));
  const res = await fetch(`${base}/agents`);
  const out = (await res.json()) as { agents: any[] };
  expect(out.agents.length).toBe(1);
  expect(out.agents[0].sessionId).toBe("a");
  expect(out.agents[0].name).toBe("VASQUEZ"); // the persona's name
  expect(out.agents[0].state).toBe("working");
  server.stop(true);
});

test("card-add creates a card and returns its id", async () => {
  const { server, post } = await cardApiServer();
  const res = await post("/action/card-add", { columnId: "backlog", title: "New task", description: "details" });
  const out = (await res.json()) as { ok: boolean; cardId: string };
  expect(out.ok).toBe(true);
  expect(out.cardId).toMatch(/^card_/);
  const snap = readSnapshot(dir, Date.now());
  expect(snap.board.cards[0]!.title).toBe("New task");
  expect(snap.board.cards[0]!.description).toBe("details");
  server.stop(true);
});

test("card-add with kind scrum makes one briefed card per project", async () => {
  const { server, post } = await cardApiServer();
  await post("/action/card-add", { columnId: "backlog", title: "Older work" });
  const body = { columnId: "backlog", title: "Scrum master", kind: "scrum", repo: "shop", repoPath: "/src/shop" };
  const first = (await (await post("/action/card-add", body)).json()) as any;
  expect(first.ok).toBe(true);
  expect(first.existing).toBeUndefined();
  // It goes to the top of the column, ahead of the work already waiting there.
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.id).toBe(first.cardId);
  expect(card.kind).toBe("scrum");
  expect(card.repo).toBe("shop");
  expect(card.repoPath).toBe("/src/shop");
  expect(card.description).toContain("scrum master for **shop** (`/src/shop`)");
  // Asking again hands back the same card instead of a second orchestrator.
  const again = (await (await post("/action/card-add", body)).json()) as any;
  expect(again).toMatchObject({ ok: true, cardId: first.cardId, existing: true });
  // Another project gets its own.
  const other = (await (await post("/action/card-add", { ...body, repo: "blog", repoPath: "/src/blog" })).json()) as any;
  expect(other.cardId).not.toBe(first.cardId);
  expect(readSnapshot(dir, Date.now()).board.cards.length).toBe(3);
  server.stop(true);
});

test("card-add rejects an unknown column and a blank title", async () => {
  const { server, post } = await cardApiServer();
  expect((await post("/action/card-add", { columnId: "ghost", title: "x" })).status).toBe(400);
  expect((await post("/action/card-add", { columnId: "backlog", title: "  " })).status).toBe(400);
  server.stop(true);
});

test("card-move moves the card; unknown card 404s, unknown column 400s", async () => {
  const { server, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await (await post("/action/card-move", { cardId, toColumnId: "review" })).json()).ok).toBe(true);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.columnId).toBe("review");
  expect((await post("/action/card-move", { cardId: "card_nope", toColumnId: "review" })).status).toBe(404);
  expect((await post("/action/card-move", { cardId, toColumnId: "ghost" })).status).toBe(400);
  server.stop(true);
});

test("card-comment appends a comment with a server-side timestamp", async () => {
  const { server, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  const before = Date.now();
  const res = await post("/action/card-comment", { cardId, author: "VOLT", text: "picked up" });
  expect(((await res.json()) as any).ok).toBe(true);
  const [c] = readSnapshot(dir, Date.now()).board.cards[0]!.comments!;
  expect(c.author).toBe("VOLT");
  expect(c.text).toBe("picked up");
  expect(c.at).toBeGreaterThanOrEqual(before);
  expect((await post("/action/card-comment", { cardId, author: "VOLT", text: "  " })).status).toBe(400);
  expect((await post("/action/card-comment", { cardId: "card_nope", author: "V", text: "x" })).status).toBe(404);
  server.stop(true);
});

test("card writes apply against the latest board (no whole-board clobber)", async () => {
  const { server, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  // two independent writers, neither sending the full board
  await post("/action/card-comment", { cardId, author: "A", text: "first" });
  await post("/action/card-move", { cardId, toColumnId: "in-progress" });
  await post("/action/card-comment", { cardId, author: "B", text: "second" });
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.columnId).toBe("in-progress");
  expect(card.comments!.map((c) => c.text)).toEqual(["first", "second"]);
  server.stop(true);
});

test("card-assign binds a live session as assignee and null clears it", async () => {
  const { server, post } = await cardApiServer();
  writeFileSync(join(dir, `${CARD_SESSION}.json`), valid({ sessionId: CARD_SESSION, name: "NOVA" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await (await post("/action/card-assign", { cardId, sessionId: CARD_SESSION })).json()).ok).toBe(true);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.assignee!.id).toBe(CARD_SESSION);
  expect((await (await post("/action/card-assign", { cardId, sessionId: null })).json()).ok).toBe(true);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.assignee).toBeUndefined();
  // a session with no status file at all can't be assigned
  expect((await post("/action/card-assign", { cardId, sessionId: "99999999-dead-4dea-bead-999999999999" })).status).toBe(404);
  server.stop(true);
});

test("card-assign binds a just-spawned session even before it enters the live view", async () => {
  // A NEW agent spawned for a card self-assigns from its SessionStart hook. If that
  // POST lands before the session surfaces as "live" (its status file is on disk but
  // outside the snapshot's freshness window / a scan hasn't run), the assign must
  // STILL bind by reading the file directly — otherwise the card is silently left
  // with no assignee for good, which is the "spawned via card, no chip" bug.
  const { server, post } = await cardApiServer();
  const STALE = "11111111-2222-4333-8444-555555555555";
  // updatedAt well past the 5-min freshness window: present on disk, absent from the live view.
  writeFileSync(join(dir, `${STALE}.json`), valid({ sessionId: STALE, name: "EMBER", updatedAt: Date.now() - 30 * 60_000 }));
  expect(readSnapshot(dir, Date.now()).agents.some((a) => a.sessionId === STALE)).toBe(false);
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await (await post("/action/card-assign", { cardId, sessionId: STALE })).json()).ok).toBe(true);
  const a = readSnapshot(dir, Date.now()).board.cards[0]!.assignee!;
  expect(a.id).toBe(STALE);
  expect(a.name).toBe("EMBER");
  server.stop(true);
});

// ---- send-task + notifications: the closed loop ---------------------------
// send-task composes the protocol prompt server-side and delivers it to the
// assigned live session. Worker card-comment/card-move wake the supervising
// scrum-master session(s), so orchestration is event-driven, not polled.
// Delivery is injected so tests capture prompts instead of driving AppleScript.

const WORKER = "502d0e8c-8790-4804-b767-0549edfc959c";
const SCRUM = "9a1b2c3d-1111-4222-8333-444455556666";

async function notifyServer(opts: { deliverOk?: boolean; deliverFreshOk?: boolean; spawn?: any } = {}) {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const sent: { sessionId: string; text: string; fresh: boolean }[] = [];
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, {
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    deliver: async (target: any, text: string) => {
      if (opts.deliverOk === false) return { ok: false, error: "no terminal" };
      sent.push({ sessionId: target.sessionId, text, fresh: false }); return { ok: true };
    },
    deliverFresh: async (target: any, text: string) => {
      if (opts.deliverFreshOk === false) return { ok: false, error: "no terminal" };
      sent.push({ sessionId: target.sessionId, text, fresh: true }); return { ok: true };
    },
  });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { server, base, post, sent };
}

test("send-task delivers the protocol prompt to the assigned live session", async () => {
  const { server, base, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  const res = await post("/action/send-task", { cardId });
  expect(((await res.json()) as any).ok).toBe(true);
  expect(sent.length).toBe(1);
  expect(sent[0]!.sessionId).toBe(WORKER);
  expect(sent[0]!.fresh).toBe(true); // a new task clears the agent's context first
  expect(sent[0]!.text).toContain("Fix bug");
  expect(sent[0]!.text).toContain(cardId);
  expect(sent[0]!.text).toContain(`${base}/action/card-comment`); // curl target is this server
  expect(sent[0]!.text).toContain('"as":"assignee"');
  expect(sent[0]!.text).toContain("assigned agent on this card, VOLT");
  // and the thread records the send
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.comments!.some((c) => c.text.includes("Sent task to VOLT"))).toBe(true);
  server.stop(true);
});

test("send-task moves the card into in-progress server-side, not left to the agent", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  await post("/action/send-task", { cardId });
  // The server put the card in the work column itself — no dependence on STEP 1.
  const card = readSnapshot(dir, Date.now()).board.cards.find((c) => c.id === cardId)!;
  expect(card.columnId).toBe("in-progress");
  // And because it's already there, the prompt tells the agent to leave it.
  expect(sent[0]!.text).toContain('already in "in-progress"');
  server.stop(true);
});

test("send-task does NOT move the card when delivery fails", async () => {
  const { server, post } = await notifyServer({ deliverFreshOk: false });
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  const res = await post("/action/send-task", { cardId });
  expect(res.status).toBe(502);
  const card = readSnapshot(dir, Date.now()).board.cards.find((c) => c.id === cardId)!;
  expect(card.columnId).toBe("backlog"); // unchanged: no half-done transition
  server.stop(true);
});

test("send-task without a live assignee is refused", async () => {
  const { server, post } = await notifyServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await post("/action/send-task", { cardId })).status).toBe(400); // unassigned
  expect((await post("/action/send-task", { cardId: "card_nope" })).status).toBe(404);
  server.stop(true);
});

// The refusals, pinned exactly: status, error text, and nothing delivered.
for (const [label, setup, status, error] of [
  ["an ended session", () => rmSync(join(dir, `${WORKER}.json`)), 404, 'assignee "VOLT" is not a live session'],
  ["a working assignee", () => writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "working" })), 409,
    "VOLT is still working — wait for it to go idle (or pause it), then resend"],
  ["a waiting assignee", () => writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "waiting" })), 409,
    "VOLT is waiting on a prompt in its terminal — answer that first, then resend"],
] as const) {
  test(`send-task to ${label} is refused with ${status}`, async () => {
    const { server, post, sent } = await notifyServer();
    writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
    const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
    await post("/action/card-assign", { cardId, sessionId: WORKER });
    setup();
    const res = await post("/action/send-task", { cardId });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ ok: false, error });
    expect(sent.length).toBe(0);
    server.stop(true);
  });
}

test("a worker's card-comment wakes the scrum master, not the worker itself", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "VOLT", text: "picked up" });
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM]);
  expect(sent[0]!.text).toContain("VOLT");
  expect(sent[0]!.text).toContain("picked up");
  expect(/^[\x00-\x7f]*$/.test(sent[0]!.text)).toBe(true); // ASCII-safe transit
  server.stop(true);
});

test("a scrum master's card-comment wakes the assignee, not itself", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  sent.length = 0;
  // CADENCE is the scrum master's crew name (its persona brings no name)
  await post("/action/card-comment", { cardId, author: "CADENCE", text: "please add a test" });
  expect(sent.map((s) => s.sessionId)).toEqual([WORKER]);
  expect(sent[0]!.text).toContain("please add a test");
  server.stop(true);
});

test("a worker's card-move wakes the scrum master", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  sent.length = 0;
  await post("/action/card-move", { cardId, toColumnId: "review", author: "VOLT" });
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM]);
  expect(sent[0]!.text).toContain('"Fix bug"');
  expect(sent[0]!.text).toContain("review");
  expect(sent[0]!.text).toContain("VOLT");
  server.stop(true);
});

test("card ops without any scrum master or assignee deliver nothing", async () => {
  const { server, post, sent } = await notifyServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "X", text: "note" });
  await post("/action/card-move", { cardId, toColumnId: "review" });
  expect(sent).toEqual([]);
  server.stop(true);
});

// ---- scoping: a scrum master hears its own project, never its own echo -----
// Two projects on one board used to cross-talk: every scrum master got every
// card's events. And a scrum master signing by bare name ("DALLAS") while its
// desk shows "DALLAS d8c1" got its own comments typed back at it.

const SCRUM2 = "d8c1ebad-1029-4826-826b-1db98f735c17";

async function twoProjects() {
  const env = await notifyServer();
  const { post } = env;
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  writeFileSync(join(dir, `${SCRUM2}.json`), valid({ sessionId: SCRUM2, persona: "scrum-master", crew: { id: "tempo-0002", name: "TEMPO" }, state: "idle" }));
  const add = async (body: object) => ((await (await post("/action/card-add", { columnId: "backlog", ...body })).json()) as any).cardId as string;
  const shopScrum = await add({ title: "Scrum master", kind: "scrum", repo: "shop" });
  const blogScrum = await add({ title: "Scrum master", kind: "scrum", repo: "blog" });
  await post("/action/card-assign", { cardId: shopScrum, sessionId: SCRUM });
  await post("/action/card-assign", { cardId: blogScrum, sessionId: SCRUM2 });
  const shopCard = await add({ title: "Shop bug", repo: "shop" });
  const blogCard = await add({ title: "Blog bug", repo: "blog" });
  const bareCard = await add({ title: "No repo" });
  env.sent.length = 0;
  return { ...env, shopCard, blogCard, bareCard };
}

test("each scrum master hears only its own project's card events", async () => {
  const { server, post, sent, shopCard, blogCard } = await twoProjects();
  await post("/action/card-comment", { cardId: shopCard, author: "VOLT", text: "shop note" });
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM]);
  sent.length = 0;
  await post("/action/card-move", { cardId: blogCard, author: "VOLT", toColumnId: "review" });
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM2]);
  server.stop(true);
});

test("a card with no repo still reaches every scrum master", async () => {
  const { server, post, sent, bareCard } = await twoProjects();
  await post("/action/card-comment", { cardId: bareCard, author: "VOLT", text: "no project" });
  expect(sent.map((s) => s.sessionId).sort()).toEqual([SCRUM, SCRUM2].sort());
  server.stop(true);
});

test("a scrum master signing by bare name is not sent its own event", async () => {
  const { server, post, sent } = await notifyServer();
  // Two DALLAS desks, so the snapshot shows "DALLAS d8c1" and "DALLAS 9a1b".
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", name: "DALLAS", state: "idle" }));
  writeFileSync(join(dir, `${SCRUM2}.json`), valid({ sessionId: SCRUM2, persona: "scrum-master", name: "DALLAS", state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  const names = readSnapshot(dir, Date.now()).agents.map((a) => a.name).sort();
  expect(names).toEqual(["DALLAS 9a1b", "DALLAS d8c1"]);
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "DALLAS", text: "mine" });
  await post("/action/card-move", { cardId, author: "DALLAS d8c1", toColumnId: "review" });
  // The bare name is both desks' own name, so neither is echoed; the suffixed
  // one is only SCRUM2's, so SCRUM still hears about the move.
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM]);
  server.stop(true);
});

// ---- cascade guards -------------------------------------------------------
// A live run showed two failure modes: notifications typed into a session
// waiting at a permission dialog pressed Enter ON the dialog (auto-approving
// pending actions), and confused scrum-masters spawning scrum-masters
// exponentially. These lock both doors.

test("nothing is typed into a session that is waiting on a dialog; it is queued instead", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "waiting" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  sent.length = 0;
  const r = (await (await post("/action/card-comment", { cardId, author: "VOLT", text: "update" })).json()) as any;
  await post("/action/card-move", { cardId, toColumnId: "review", author: "VOLT" });
  expect(sent).toEqual([]);
  expect(r.delivery).toEqual([{ sessionId: SCRUM, name: "CADENCE", via: "queued" }]);
  server.stop(true);
});

// ---- the inbox: events for a busy session wait for its turn to end --------
// Typing into a working session races its next permission prompt, and typing
// into a waiting one presses keys on the dialog. So only an IDLE session is
// typed at; everything else queues, and the session's Stop hook drains the
// queue as the turn ends (the same idea as a queued message, minus the pty).

test("an event for a working session is queued and drained by its Stop hook", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "working" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "VOLT", text: "first" });
  await post("/action/card-comment", { cardId, author: "VOLT", text: "second" });
  expect(sent).toEqual([]);
  // the snapshot shows the backlog, so the human can see it is waiting to land
  const agents = ((await (await fetch(`http://localhost:${server.port}/agents`)).json()) as any).agents;
  expect(agents.find((a: any) => a.sessionId === SCRUM).inbox).toBe(2);
  const drained = (await (await post("/action/inbox-drain", { sessionId: SCRUM })).json()) as any;
  expect(drained.ok).toBe(true);
  expect(drained.items.length).toBe(2);
  expect(drained.items[0]).toContain("first");
  expect(drained.items[1]).toContain("second");
  // drained means gone
  expect(((await (await post("/action/inbox-drain", { sessionId: SCRUM })).json()) as any).items).toEqual([]);
  server.stop(true);
});

test("a typed delivery that fails falls back to the queue rather than vanishing", async () => {
  const { server, post, sent } = await notifyServer({ deliverOk: false });
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  const r = (await (await post("/action/card-comment", { cardId, author: "VOLT", text: "note" })).json()) as any;
  expect(sent).toEqual([]);
  expect(r.delivery).toEqual([{ sessionId: SCRUM, name: "CADENCE", via: "queued" }]);
  expect(((await (await post("/action/inbox-drain", { sessionId: SCRUM })).json()) as any).items.length).toBe(1);
  server.stop(true);
});

test("a queued item is typed as soon as the session turns idle (no-hook fallback)", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "working" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "VOLT", text: "note" });
  expect(sent).toEqual([]);
  // The fs watcher (debounced) notices the file and the next push flushes.
  // Rewritten on a beat rather than once: fs.watch can miss a change made in
  // the moment right after it is registered — on a machine busy with a second
  // test run, measurably so — and one missed event would hang this for good.
  const turnIdle = () => writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  turnIdle();
  for (let i = 0; i < 80 && sent.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (i % 10 === 9) turnIdle();
  }
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM]);
  expect(sent[0]!.text).toContain("note");
  expect(((await (await post("/action/inbox-drain", { sessionId: SCRUM })).json()) as any).items).toEqual([]);
  server.stop(true);
}, 15_000);

// ---- identity: a write is signed by WHO the session is, not a typed name ---
// Personas hardcode a name, desks get renamed, and the MCP fallback signs as
// "Claude" — so name-matching mis-attributed comments and woke agents with
// their own updates. `as: "assignee"` resolves to the card's assignee.

test("a comment signed as: assignee carries the assignee's CURRENT desk name", async () => {
  const { server, post } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "PIXEL", state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  setNameOverride(dir, WORKER, "Biff"); // renamed AFTER assignment
  await post("/action/card-comment", { cardId, as: "assignee", text: "hello" });
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.comments!.at(-1)!.author).toBe("Biff");
  server.stop(true);
});

test("a comment signed as: assignee on an unassigned card is refused", async () => {
  const { server, post } = await notifyServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await post("/action/card-comment", { cardId, as: "assignee", text: "hello" })).status).toBe(400);
  server.stop(true);
});

test("an assignee signing as itself is never woken by its own update, whatever its persona says", async () => {
  const { server, post, sent } = await notifyServer();
  // desk name is PIXEL (persona), but the human renamed it Biff: the old
  // name-based exclusion would have typed PIXEL's own comment back at it
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "PIXEL", state: "idle" }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  setNameOverride(dir, WORKER, "Biff");
  sent.length = 0;
  await post("/action/card-comment", { cardId, as: "assignee", text: "progress" });
  await post("/action/card-move", { cardId, as: "assignee", toColumnId: "in-progress" });
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM, SCRUM]);
  expect(sent[0]!.text).toContain("Biff");
  server.stop(true);
});

test("a write may also be signed by sessionId, resolving to that session's name", async () => {
  const { server, post } = await notifyServer();
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-comment", { cardId, sessionId: SCRUM, text: "from the orchestrator" });
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.comments!.at(-1)!.author).toBe("CADENCE");
  expect((await post("/action/card-comment", { cardId, sessionId: "0000-nope", text: "x" })).status).toBe(404);
  server.stop(true);
});

// ---- reply semantics: who is woken, and whether an answer is expected -------
// Every notification used to demand a reply, so worker and scrum master
// acknowledged each other's acknowledgements. Now a notification says which.

test("a human's comment wakes the assignee expecting a reply, and the scrum master FYI", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "You", text: "is this done?" });
  const toWorker = sent.find((s) => s.sessionId === WORKER)!;
  const toScrum = sent.find((s) => s.sessionId === SCRUM)!;
  expect(toWorker.text).toContain("reply expected");
  expect(toScrum.text).toContain("no reply needed");
  server.stop(true);
});

// The browser signs the human's writes "You". That is the human's own byline;
// typed into an agent's terminal it read as the agent itself ("You merged").
test("an agent is never told \"You\" did what the human did", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "You", text: "is this done?" });
  await post("/action/card-move", { cardId, toColumnId: "review", author: "You" });
  expect(sent.length).toBeGreaterThan(0);
  for (const s of sent) {
    expect(s.text).not.toMatch(/\bYou (commented|moved)\b/);
    expect(s.text).toMatch(/The user (commented|moved)/);
  }
  // The board keeps the human's own byline: the dashboard reads "You" as them.
  const { board } = (await (await fetch(`http://localhost:${server.port}/board`)).json()) as any;
  expect(board.cards[0].comments.at(-1).author).toBe("You");
  server.stop(true);
});

test("an assignee's own comment reaches the scrum master as FYI, no reply needed", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  sent.length = 0;
  await post("/action/card-comment", { cardId, as: "assignee", text: "done, verified" });
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM]);
  expect(sent[0]!.text).toContain("no reply needed");
  server.stop(true);
});

test("a human moving a card FORWARD does not wake the assignee; moving it BACK does", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  await post("/action/card-move", { cardId, toColumnId: "review", author: "You" });
  sent.length = 0;
  await post("/action/card-move", { cardId, toColumnId: "done", author: "You" });
  expect(sent).toEqual([]);
  await post("/action/card-move", { cardId, toColumnId: "in-progress", author: "You" });
  expect(sent.map((s) => s.sessionId)).toEqual([WORKER]);
  expect(sent[0]!.text).toContain("reply expected");
  server.stop(true);
});

test("send-task to a WORKING assignee is refused rather than clearing its context mid-task", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "working" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  sent.length = 0;
  const res = await post("/action/send-task", { cardId });
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).error).toContain("working");
  expect(sent).toEqual([]);
  server.stop(true);
});

test("column-update sets and clears a column's stage", async () => {
  const { server, post } = await notifyServer();
  const { columnId } = (await (await post("/action/column-add", { name: "Merged" })).json()) as any;
  await post("/action/column-update", { columnId, stage: "done" });
  expect(readSnapshot(dir, Date.now()).board.columns.at(-1)!.stage).toBe("done");
  await post("/action/column-update", { columnId, stage: null });
  expect(readSnapshot(dir, Date.now()).board.columns.at(-1)!.stage).toBeUndefined();
  expect((await post("/action/column-update", { columnId, stage: "bogus" })).status).toBe(400);
  server.stop(true);
});

test("send-task to a waiting assignee is refused, not typed into its dialog", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT", state: "waiting" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  sent.length = 0;
  const res = await post("/action/send-task", { cardId });
  expect(res.status).toBe(409);
  expect(sent).toEqual([]);
  server.stop(true);
});

test("an agent (no sec-fetch-site) may not spawn a scrum-master", async () => {
  const { server, base } = await cardApiServer();
  const res = await fetch(`${base}/action/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp", text: "orchestrate", persona: "scrum-master" }),
  });
  expect(res.status).toBe(403);
  expect(((await res.json()) as any).ok).toBe(false);
  server.stop(true);
});

test("card-update renames a card and sets its description", async () => {
  const { server, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await (await post("/action/card-update", { cardId, title: "Renamed", description: "why" })).json()).ok).toBe(true);
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.title).toBe("Renamed");
  expect(card.description).toBe("why");
  server.stop(true);
});

test("card-update leaves out-of-scope fields alone", async () => {
  const { server, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T", description: "keep me" })).json()) as any;
  await post("/action/card-update", { cardId, title: "Renamed" });
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.description).toBe("keep me");
  await post("/action/card-update", { cardId, description: "" });
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.title).toBe("Renamed");
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.description).toBe("");
  server.stop(true);
});

test("card-update rejects a blank title, no fields, and an unknown card", async () => {
  const { server, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await post("/action/card-update", { cardId, title: "  " })).status).toBe(400);
  expect((await post("/action/card-update", { cardId })).status).toBe(400);
  expect((await post("/action/card-update", { cardId: "card_nope", title: "x" })).status).toBe(404);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.title).toBe("T");
  server.stop(true);
});

// ---- column-* and the destructive card ops: the write half the UI needs so it
// never has to send a whole board. Each is applied against a fresh read, so a
// browser edit can no longer erase an agent's concurrent comment.

test("column-add appends a column and returns its id", async () => {
  const { server, base, post } = await cardApiServer();
  const res = await post("/action/column-add", { name: "Blocked" });
  expect(res.status).toBe(200);
  const { ok, columnId } = (await res.json()) as any;
  expect(ok).toBe(true);
  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.columns.at(-1)).toEqual({ id: columnId, name: "Blocked", instruction: "" });
  server.stop(true);
});

test("column-update changes name and instruction independently", async () => {
  const { server, base, post } = await cardApiServer();
  await post("/action/column-update", { columnId: "backlog", instruction: "read me" });
  await post("/action/column-update", { columnId: "backlog", name: "Icebox" });
  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  const col = board.columns.find((c: any) => c.id === "backlog");
  expect(col.name).toBe("Icebox");
  expect(col.instruction).toBe("read me"); // the rename did not wipe it
  expect((await post("/action/column-update", { columnId: "backlog" })).status).toBe(400);
  expect((await post("/action/column-update", { columnId: "ghost", name: "x" })).status).toBe(404);
  server.stop(true);
});

test("column-delete removes the column and its cards; the last column is refused", async () => {
  const { server, base, post } = await cardApiServer();
  await post("/action/card-add", { columnId: "review", title: "doomed" });
  expect((await (await post("/action/column-delete", { columnId: "review" })).json()).ok).toBe(true);
  let { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.columns.some((c: any) => c.id === "review")).toBe(false);
  expect(board.cards).toHaveLength(0);

  for (const id of ["backlog", "in-progress"]) await post("/action/column-delete", { columnId: id });
  const res = await post("/action/column-delete", { columnId: "done" });
  expect(res.status).toBe(400); // an empty board would reset to the default
  ({ board } = (await (await fetch(`${base}/board`)).json()) as any);
  expect(board.columns.map((c: any) => c.id)).toEqual(["done"]);
  server.stop(true);
});

test("column-reorder moves a column to an index", async () => {
  const { server, base, post } = await cardApiServer();
  await post("/action/column-reorder", { columnId: "done", toIndex: 0 });
  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.columns.map((c: any) => c.id)).toEqual(["done", "backlog", "in-progress", "review"]);
  server.stop(true);
});

test("card-delete removes one card and card-restore puts it back with its comments", async () => {
  const { server, base, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "keep me" })).json()) as any;
  await post("/action/card-add", { columnId: "backlog", title: "neighbour" });
  await post("/action/card-comment", { cardId, author: "VOLT", text: "do not lose this" });

  const before = (await (await fetch(`${base}/board`)).json()) as any;
  const card = before.board.cards.find((c: any) => c.id === cardId);
  expect((await (await post("/action/card-delete", { cardId })).json()).ok).toBe(true);
  expect((await post("/action/card-delete", { cardId: "card_nope" })).status).toBe(404);

  expect((await (await post("/action/card-restore", { card, index: 0 })).json()).ok).toBe(true);
  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.cards.map((c: any) => c.title)).toEqual(["keep me", "neighbour"]);
  expect(board.cards[0].comments).toHaveLength(1);
  server.stop(true);
});

test("column-restore puts a deleted column back at its index with its cards", async () => {
  const { server, base, post } = await cardApiServer();
  await post("/action/card-add", { columnId: "in-progress", title: "rides along" });
  const before = (await (await fetch(`${base}/board`)).json()) as any;
  const column = before.board.columns.find((c: any) => c.id === "in-progress");
  const cards = before.board.cards.filter((c: any) => c.columnId === "in-progress");

  await post("/action/column-delete", { columnId: "in-progress" });
  expect((await (await post("/action/column-restore", { column, index: 1, cards })).json()).ok).toBe(true);

  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.columns.map((c: any) => c.id)).toEqual(["backlog", "in-progress", "review", "done"]);
  expect(board.cards.map((c: any) => c.title)).toEqual(["rides along"]);
  server.stop(true);
});

test("a card-scoped UI edit no longer erases a comment posted since the browser's last read", async () => {
  const { server, base, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "shared" })).json()) as any;

  // The browser reads the board here, then the user starts typing a rename.
  const stale = (await (await fetch(`${base}/board`)).json()) as any;
  expect(stale.board.cards[0].comments).toBeUndefined();

  // An agent comments while that rename is in flight.
  await post("/action/card-comment", { cardId, author: "ANVIL", text: "found the bug" });

  // The rename lands as a card-scoped edit, applied against a FRESH read.
  await post("/action/card-update", { cardId, title: "shared (renamed)" });

  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.cards[0].title).toBe("shared (renamed)");
  expect(board.cards[0].comments).toHaveLength(1); // survived the rename
  server.stop(true);
});

// --- the MERGE key's two endpoints ------------------------------------------
// A card only knows where its work lives through its assignee's status file, so
// these check the whole resolution: card -> assignee -> working dir -> git.

const MERGE_SESSION = "7c1e2f30-aaaa-4bbb-8ccc-ddddeeeeffff";
const mergeBase = fixtureDir("server-merge-repo");
let mergeSeq = 0;
/** The repo the latest mergeFixture() built; the assertions below read its log. */
let mergeRepo = "";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

/** A throwaway repo with a linked worktree holding one committed change, plus a
 *  status file pointing a session at that worktree. Returns the card id of a
 *  card assigned to it. */
async function mergeFixture(post: (p: string, b: object) => Promise<Response>, opts: { wt?: string } = {}): Promise<string> {
  // A repo of its OWN per call. Re-initialising one path raced with git's
  // background housekeeping from the previous fixture: the setup commit failed
  // silently and the endpoint under test answered "nothing committed yet".
  mergeRepo = join(mergeBase, `r${mergeSeq++}`);
  mkdirSync(mergeRepo, { recursive: true });
  await git(mergeRepo, "init", "-q", "-b", "main");
  await git(mergeRepo, "config", "user.email", "t@t");
  await git(mergeRepo, "config", "user.name", "t");
  writeFileSync(join(mergeRepo, "README"), "root\n");
  await git(mergeRepo, "add", "-A");
  await git(mergeRepo, "commit", "-q", "-m", "root");
  const wt = join(mergeRepo, opts.wt ?? "wt");
  await git(mergeRepo, "worktree", "add", "-q", "-b", "feature", wt, "HEAD");
  // Made the way the launcher makes one, marker included.
  await markWorktreeOwned(wt);
  writeFileSync(join(wt, "feature.txt"), "done\n");
  await git(wt, "add", "-A");
  await git(wt, "commit", "-q", "-m", "the work");

  writeFileSync(join(dir, `${MERGE_SESSION}.json`), valid({ sessionId: MERGE_SESSION, name: "VOLT", cwd: wt, branch: "feature" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Land it" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: MERGE_SESSION });
  return cardId;
}

test("GET /merge-state reports the assignee's committed work", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  const state = (await (await fetch(`${base}/merge-state?cardId=${cardId}`)).json()) as any;
  expect(state).toMatchObject({ branch: "feature", base: "main", ahead: 1, committed: true, ready: true });
  server.stop(true);
});

test("GET /merge-preview lists the commits and files a merge would land", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  const p = (await (await fetch(`${base}/merge-preview?cardId=${cardId}`)).json()) as any;
  expect(p).toMatchObject({ branch: "feature", base: "main", totalCommits: 1, totalFiles: 1 });
  expect(p.files[0].path).toBe("feature.txt");
  expect((await fetch(`${base}/merge-preview?cardId=card_nope`)).status).toBe(404);
  server.stop(true);
});

test("GET /merge-state explains a card with nowhere to merge from", async () => {
  const { server, base, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Unassigned" })).json()) as any;
  expect((await fetch(`${base}/merge-state?cardId=${cardId}`)).status).toBe(400); // no assignee
  expect((await fetch(`${base}/merge-state?cardId=card_nope`)).status).toBe(404);
  server.stop(true);
});

// --- a card remembers where its work lives -----------------------------------
// The status file goes when the session ends (SessionEnd hook, the scanner's
// prune), so binding an agent records the card's folder and branch on the card
// itself, and the MERGE key falls back to that record.

const cardOf = async (base: string, cardId: string) =>
  ((await (await fetch(`${base}/board`)).json()) as any).board.cards.find((k: any) => k.id === cardId);

test("card-assign records the card's work folder, branch and repo", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  expect((await cardOf(base, cardId)).work).toEqual({ cwd: join(mergeRepo, "wt"), branch: "feature", root: realpathSync(mergeRepo) });
  server.stop(true);
});

test("send-task records the card's work folder and branch too", async () => {
  const { server, base, post } = await cardApiServer({ deliverFresh: async () => ({ ok: true }) });
  const cardId = await mergeFixture(post);
  // Forget the record card-assign made, so only send-task can put it back.
  const board = JSON.parse(readFileSync(join(dir, ".line.json"), "utf8"));
  delete board.cards.find((k: any) => k.id === cardId).work;
  writeFileSync(join(dir, ".line.json"), JSON.stringify(board));
  writeFileSync(join(dir, `${MERGE_SESSION}.json`), valid({ sessionId: MERGE_SESSION, name: "VOLT", cwd: join(mergeRepo, "wt"), branch: "feature", state: "idle" }));
  expect(((await (await post("/action/send-task", { cardId })).json()) as any).ok).toBe(true);
  expect((await cardOf(base, cardId)).work).toEqual({ cwd: join(mergeRepo, "wt"), branch: "feature", root: realpathSync(mergeRepo) });
  server.stop(true);
});

test("a spawn bound to its session without hooks records the card's work too", async () => {
  const { server, base, post } = await cardApiServer({ spawn: async (cwd: string) => ({ ok: true, cwd, worktreeCreated: true }) });
  await mergeFixture(post); // for its repo and worktree; this card is the other one
  rmSync(join(dir, `${MERGE_SESSION}.json`));
  const wt = join(mergeRepo, "wt");
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Spawned" })).json()) as any;
  expect((await post("/action/spawn", { cwd: wt, text: "go", cardId })).status).toBe(200);
  // The new session shows up, as the scanner would write it: no crew, no pid.
  const SPAWNED = "3e5f7a90-1111-4222-8333-444455556666";
  writeFileSync(join(dir, `${SPAWNED}.json`), valid({ sessionId: SPAWNED, name: "NEWT", cwd: wt, branch: "feature", state: "idle" }));
  let card: any;
  for (let i = 0; i < 40 && !card?.work; i++) {
    await post("/action/card-comment", { cardId, author: "You", text: "nudge" }); // any write pushes, which settles spawns
    await Bun.sleep(25);
    card = await cardOf(base, cardId);
  }
  expect(card.assignee?.id).toBe(SPAWNED);
  expect(card.work).toEqual({ cwd: wt, branch: "feature", root: realpathSync(mergeRepo) });
  server.stop(true);
});

test("GET /merge-state still finds the branch once the status file is gone", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  rmSync(join(dir, `${MERGE_SESSION}.json`));
  const state = await fetch(`${base}/merge-state?cardId=${cardId}`);
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ branch: "feature", base: "main", ahead: 1, committed: true, ready: true });
  const p = (await (await fetch(`${base}/merge-preview?cardId=${cardId}`)).json()) as any;
  expect(p).toMatchObject({ branch: "feature", totalCommits: 1 });
  server.stop(true);
});

test("card-merge lands the branch once the status file is gone", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  rmSync(join(dir, `${MERGE_SESSION}.json`));
  expect(await (await mergePost(base, { cardId, author: "You" })).json()).toMatchObject({ ok: true, branch: "feature", base: "main" });
  expect(gitOut(mergeRepo, "show", "main:feature.txt")).toBe("done");
  server.stop(true);
});

test("GET /merge-state says plainly when the worktree is gone but its branch is not", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  rmSync(join(dir, `${MERGE_SESSION}.json`));
  await git(mergeRepo, "worktree", "remove", "--force", join(mergeRepo, "wt"));
  const state = await fetch(`${base}/merge-state?cardId=${cardId}`);
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({
    worktreeGone: true, branch: "feature", base: "main", ahead: 1, committed: false,
    blocked: "this card's worktree was removed, but its branch feature is still in the repo with 1 commit not in main",
  });
  server.stop(true);
});

test("GET /merge-state says plainly when the worktree and its branch are both gone", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  await git(mergeRepo, "worktree", "remove", "--force", join(mergeRepo, "wt"));
  await git(mergeRepo, "branch", "-D", "feature");
  const state = await fetch(`${base}/merge-state?cardId=${cardId}`);
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ worktreeGone: true, branch: "", committed: false, blocked: "this card's worktree was removed" });
  const p = await fetch(`${base}/merge-preview?cardId=${cardId}`);
  expect(((await p.json()) as any).error).toBe("this card's worktree was removed");
  server.stop(true);
});

test("POST /action/card-merge lands the branch and records it on the card", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  const res = await fetch(`${base}/action/card-merge`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ cardId, author: "You" }),
  });
  expect(await res.json()).toMatchObject({ ok: true, branch: "feature", base: "main" });

  const log = Bun.spawnSync(["git", "-C", mergeRepo, "log", "-1", "--pretty=%s"]).stdout.toString();
  expect(log).toContain("Merge branch 'feature'");

  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.cards[0].comments.some((c: any) => c.text === "Merged feature into main.")).toBe(true);
  server.stop(true);
});

// card-merge signs its "Merged X into Y" comment through the same resolver as
// card-move/card-comment, so the three conventions mean the same thing on every
// write path. Reachable from the dashboard only (the 403 above), but a merge
// pressed on someone else's card should still be able to say whose work landed.
const mergePost = (base: string, body: object) =>
  fetch(`${base}/action/card-merge`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });

const mergeComment = async (base: string) => {
  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  return board.cards[0].comments.find((c: any) => c.text.startsWith("Merged "));
};

// After a merge the agent's work is done, so its session is ended — the live
// assignee only, and the merge stands whether or not the tab could be closed.
test("card-merge ends the assignee's live session once the work lands", async () => {
  const quit: string[] = [];
  const { server, base, post } = await cardApiServer({ quit: async (t) => { quit.push(t.cwd); return { ok: true }; } });
  const cardId = await mergeFixture(post);
  const res = (await (await mergePost(base, { cardId, author: "You" })).json()) as any;
  expect(res).toMatchObject({ ok: true, quit: { ok: true } });
  expect(quit).toEqual([join(mergeRepo, "wt")]); // the assignee's own session
  server.stop(true);
});

test("card-merge by the human tells the scrum master \"The user merged\", not \"You merged\"", async () => {
  const sent: string[] = [];
  const { server, base, post } = await cardApiServer({ deliver: async (_t, text) => { sent.push(text); return { ok: true }; } });
  const cardId = await mergeFixture(post);
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  expect(((await (await mergePost(base, { cardId, author: "You" })).json()) as any).ok).toBe(true);
  for (let i = 0; i < 20 && !sent.length; i++) await new Promise((r) => setTimeout(r, 25));
  expect(sent.join("\n")).toContain("The user merged");
  expect(sent.join("\n")).not.toContain("You merged");
  server.stop(true);
});

// Moving a card into Done ends its agent too, through the same injectable quit
// — and a merge ends it once, not once per path.
test("card-move into Done ends the assignee's session through quit", async () => {
  const quit: string[] = [];
  const { server, post } = await cardApiServer({ quit: async (t) => { quit.push(t.cwd); return { ok: true }; } });
  const cardId = await mergeFixture(post);
  const res = (await (await post("/action/card-move", { cardId, toColumnId: "done" })).json()) as any;
  expect(res).toMatchObject({ ok: true, ended: true });
  expect(quit).toEqual([join(mergeRepo, "wt")]);
  server.stop(true);
});

test("card-merge ends the assignee's session exactly once", async () => {
  const quit: string[] = [];
  const { server, base, post } = await cardApiServer({ quit: async (t) => { quit.push(t.cwd); return { ok: true }; } });
  const cardId = await mergeFixture(post);
  await mergePost(base, { cardId, author: "You" });
  await Bun.sleep(50); // let any after-notify work run
  expect(quit).toEqual([join(mergeRepo, "wt")]);
  server.stop(true);
});

test("card-merge leaves sessions alone when the merge is refused", async () => {
  const quit: string[] = [];
  const { server, base, post } = await cardApiServer({ quit: async (t) => { quit.push(t.cwd); return { ok: true }; } });
  const cardId = await mergeFixture(post);
  writeFileSync(join(mergeRepo, "wt", "dirty.txt"), "uncommitted\n");
  expect((await mergePost(base, { cardId, author: "You" })).status).toBe(409);
  expect(quit).toEqual([]);
  server.stop(true);
});

// The preview the human read names a tip; if the branch moved since (a new
// commit, or an amend that keeps the count), the merge is refused, not landed.
test("card-merge refuses a stale tip and lands nothing", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  const wt = join(mergeRepo, "wt");
  const seen = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"]).stdout.toString().trim();
  await git(wt, "commit", "-q", "--amend", "-m", "the work, amended");
  const mainBefore = Bun.spawnSync(["git", "-C", mergeRepo, "rev-parse", "main"]).stdout.toString().trim();

  const res = await mergePost(base, { cardId, author: "You", tip: seen });
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).error).toMatch(/moved since you looked/);
  expect(Bun.spawnSync(["git", "-C", mergeRepo, "rev-parse", "main"]).stdout.toString().trim()).toBe(mainBefore);

  const now = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"]).stdout.toString().trim();
  expect(((await (await mergePost(base, { cardId, author: "You", tip: now })).json()) as any).ok).toBe(true);
  server.stop(true);
});

// A worktree the dashboard made (<repo>/.claude/worktrees/<name>) is removed
// with its branch once the work lands; one it can't remove stays, and the card
// says why. Either way the merge stands.
const AGENT_WT = join(".claude", "worktrees", "feature");
const gitOut = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args]).stdout.toString().trim();

test("card-merge removes the agent's clean worktree and its merged branch", async () => {
  const { server, base, post } = await cardApiServer({ quit: async () => ({ ok: true }) });
  const cardId = await mergeFixture(post, { wt: AGENT_WT });
  const res = (await (await mergePost(base, { cardId, author: "You" })).json()) as any;
  expect(res).toMatchObject({ ok: true, branch: "feature", cleanup: { removed: true, branchDeleted: true } });
  expect(existsSync(join(mergeRepo, AGENT_WT))).toBe(false);
  expect(gitOut(mergeRepo, "worktree", "list")).not.toContain("feature");
  expect(gitOut(mergeRepo, "branch", "--list", "feature")).toBe("");
  expect(gitOut(mergeRepo, "show", "main:feature.txt")).toBe("done");

  // The card still answers for its work: merged, not an error.
  const state = await fetch(`${base}/merge-state?cardId=${cardId}`);
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ committed: false, ready: false, blocked: "already merged" });
  server.stop(true);
});

test("card-merge keeps a worktree it can't remove, and says why on the card", async () => {
  const { server, base, post } = await cardApiServer({ quit: async () => ({ ok: true }) });
  const cardId = await mergeFixture(post, { wt: AGENT_WT });
  await git(mergeRepo, "worktree", "lock", join(mergeRepo, AGENT_WT));
  const res = (await (await mergePost(base, { cardId, author: "You" })).json()) as any;
  expect(res).toMatchObject({ ok: true, cleanup: { removed: false } });
  expect(existsSync(join(mergeRepo, AGENT_WT))).toBe(true);
  expect(gitOut(mergeRepo, "branch", "--list", "feature")).toContain("feature");
  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.cards[0].comments.some((c: any) => /^worktree kept: .*lock/.test(c.text))).toBe(true);
  server.stop(true);
});

test("card-merge leaves a worktree outside .claude/worktrees alone, without a note", async () => {
  const { server, base, post } = await cardApiServer({ quit: async () => ({ ok: true }) });
  const cardId = await mergeFixture(post);
  expect(await (await mergePost(base, { cardId, author: "You" })).json()).toMatchObject({ ok: true, cleanup: { removed: false } });
  expect(existsSync(join(mergeRepo, "wt"))).toBe(true);
  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  expect(board.cards[0].comments.map((c: any) => c.text)).toEqual(["Merged feature into main."]);
  server.stop(true);
});

test("card-merge still lands when the session can't be closed", async () => {
  const { server, base, post } = await cardApiServer({ quit: async () => ({ ok: false, error: "couldn't find the terminal" }) });
  const cardId = await mergeFixture(post);
  const res = (await (await mergePost(base, { cardId, author: "You" })).json()) as any;
  expect(res).toMatchObject({ ok: true, branch: "feature", quit: { ok: false } });
  server.stop(true);
});


test("card-merge signs as: \"assignee\" like every other card write", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  expect(await (await mergePost(base, { cardId, as: "assignee" })).json()).toMatchObject({ ok: true });
  expect((await mergeComment(base)).author).toBe("VOLT");
  server.stop(true);
});

test("card-merge signs by sessionId, and still falls back to You unsigned", async () => {
  const { server, base, post } = await cardApiServer();
  let cardId = await mergeFixture(post);
  expect(await (await mergePost(base, { cardId, sessionId: MERGE_SESSION })).json()).toMatchObject({ ok: true });
  expect((await mergeComment(base)).author).toBe("VOLT");
  server.stop(true);

  const second = await cardApiServer();
  cardId = await mergeFixture(second.post);
  expect(await (await mergePost(second.base, { cardId })).json()).toMatchObject({ ok: true });
  expect((await mergeComment(second.base)).author).toBe("You");
  second.server.stop(true);
});

// The signature is checked before the merge runs: a rejected one must not leave
// the trunk moved with nothing on the card to say who moved it.
test("card-merge rejects a signature it cannot honour without merging", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  const res = await mergePost(base, { cardId, sessionId: "11111111-2222-4333-8444-555555555555" });
  expect(res.status).toBe(404);
  const log = Bun.spawnSync(["git", "-C", mergeRepo, "log", "-1", "--pretty=%s"]).stdout.toString();
  expect(log).not.toContain("Merge branch");
  server.stop(true);
});

test("card-merge is browser-only — an agent cannot land its own work", async () => {
  const { server, base, post } = await cardApiServer();
  const cardId = await mergeFixture(post);
  const res = await post("/action/card-merge", { cardId }); // no sec-fetch-site: a scripted client
  expect(res.status).toBe(403);
  const log = Bun.spawnSync(["git", "-C", mergeRepo, "log", "-1", "--pretty=%s"]).stdout.toString();
  expect(log).not.toContain("Merge branch");
  server.stop(true);
});

// ---- crew: the identity that outlives the session id ------------------------
// A /clear (which send-task does) mints a new session id. The crew id minted at
// spawn rides the env into every later session, so a card, a rename and the
// notes follow the agent rather than the id. See src/lib/crew.ts.

const RIPLEY = { id: "ripley-3f2a", name: "RIPLEY" };
const WORKER2 = "7777aaaa-1111-4222-8333-444455556666";

test("card-assign records the assignee's crew id, and the snapshot shows the crew name", async () => {
  const { server, post } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "HASHED", state: "idle", crew: RIPLEY }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  const snap = readSnapshot(dir, Date.now());
  expect(snap.board.cards[0]!.assignee).toEqual({ id: WORKER, name: "RIPLEY", crew: "ripley-3f2a" });
  expect(snap.agents[0]!.name).toBe("RIPLEY");
  server.stop(true);
});

test("after a /clear the card follows the crew member into its new session id", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, state: "idle", crew: RIPLEY }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T", description: "do it" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  await post("/action/card-comment", { cardId, as: "assignee", text: "first pass done" });
  // The /clear: the old session file goes, a new one arrives under the same crew.
  rmSync(join(dir, `${WORKER}.json`));
  writeFileSync(join(dir, `${WORKER2}.json`), valid({ sessionId: WORKER2, state: "idle", crew: RIPLEY }));
  sent.length = 0;
  // Signing as the assignee resolves to the NEW session: it wakes the scrum
  // master, not itself.
  const r = (await (await post("/action/card-comment", { cardId, as: "assignee", text: "back on it" })).json()) as any;
  expect(r.ok).toBe(true);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.comments!.at(-1)!.author).toBe("RIPLEY");
  expect(sent.map((x) => x.sessionId)).toEqual([SCRUM]);
  // A human's comment reaches the new session.
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "You", text: "how is it going?" });
  expect(sent.map((x) => x.sessionId).sort()).toEqual([SCRUM, WORKER2].sort());
  // send-task finds the new session, and tells the agent it has been here before.
  sent.length = 0;
  const st = await post("/action/send-task", { cardId });
  expect(st.status).toBe(200);
  expect(sent.length).toBe(1);
  expect(sent[0]!.sessionId).toBe(WORKER2);
  expect(sent[0]!.text).toContain("You have worked this card before");
  server.stop(true);
});

test("send-task to an agent new to the card does not claim it has been there", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, state: "idle", crew: RIPLEY }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  await post("/action/send-task", { cardId });
  expect(sent[0]!.text).not.toContain("worked this card before");
  server.stop(true);
});

test("crew-note keeps notes by crew id, by session id, or as a card's assignee", async () => {
  const { server, post } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, state: "idle", crew: RIPLEY }));
  let r = (await (await post("/action/crew-note", { crew: "ripley-3f2a", text: "tests live in tests/" })).json()) as any;
  expect(r).toEqual({ ok: true, notes: "tests live in tests/\n" });
  r = (await (await post("/action/crew-note", { sessionId: WORKER, text: "bun test runs them" })).json()) as any;
  expect(r.notes).toBe("tests live in tests/\nbun test runs them\n");
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  r = (await (await post("/action/crew-note", { cardId, as: "assignee", text: "only the cap", replace: true })).json()) as any;
  expect(r.notes).toBe("only the cap\n");
  expect(readFileSync(join(dir, "crew", "ripley-3f2a.md"), "utf8")).toBe("only the cap\n");
  server.stop(true);
});

test("crew-note refuses a bad id, a crewless session, an unassigned card, and a note past the cap", async () => {
  const { server, post } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, state: "idle" }));
  expect((await post("/action/crew-note", { crew: "../x", text: "n" })).status).toBe(400);
  expect((await post("/action/crew-note", { sessionId: WORKER, text: "n" })).status).toBe(400);
  expect((await post("/action/crew-note", { sessionId: "0000-nope", text: "n" })).status).toBe(404);
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await post("/action/crew-note", { cardId, as: "assignee", text: "n" })).status).toBe(400);
  expect((await post("/action/crew-note", { text: "n" })).status).toBe(400);
  const big = await post("/action/crew-note", { crew: "ripley-3f2a", text: "x".repeat(3000) });
  expect(big.status).toBe(400);
  expect(((await big.json()) as any).error).toContain("replace");
  server.stop(true);
});

test("a rename is stored against the crew, so it survives the session id changing", async () => {
  const { server, post } = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, state: "idle", crew: RIPLEY }));
  await post("/action/rename", { sessionId: WORKER, name: "ELLEN" });
  expect(readSnapshot(dir, Date.now()).agents[0]!.name).toBe("ELLEN");
  rmSync(join(dir, `${WORKER}.json`));
  writeFileSync(join(dir, `${WORKER2}.json`), valid({ sessionId: WORKER2, state: "idle", crew: RIPLEY }));
  expect(readSnapshot(dir, Date.now()).agents[0]!.name).toBe("ELLEN");
  server.stop(true);
});

test("name precedence: override > crew > persona name > hashed", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", name: "HASHED", persona: "backend-dev", crew: { id: "kane-1", name: "KANE" } }));
  expect(readSnapshot(dir, Date.now()).agents[0]!.name).toBe("KANE");
  setNameOverride(dir, "kane-1", "MINE");
  expect(readSnapshot(dir, Date.now()).agents[0]!.name).toBe("MINE");
});

// ---- the /events stream stays open on a quiet board -------------------------
// Bun drops a connection after 10s with nothing sent. The stream only speaks
// when the board changes, so a quiet board used to lose it every ~10s and the
// header flashed "RECONNECTING" at a healthy server. A comment line keeps it up.

test("/events sends a keep-alive comment while the board is quiet", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { heartbeatMs: 40 });
  const res = await fetch(`http://localhost:${server.port}/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = "";
  const end = Date.now() + 2_000;
  while (!seen.includes(": ping") && Date.now() < end) seen += dec.decode((await reader.read()).value);
  await reader.cancel();
  expect(seen).toContain(": ping\n\n");
  server.stop(true);
});

// ---- reassigning a card ------------------------------------------------------
// card-assign used to tell nobody. The agent taken off a card kept working it,
// and its footer's `as: "assignee"` then signed its writes with the NEW
// assignee's name. Now the old assignee is told to stop, and a write that
// carries the caller's crew id is refused when that crew is no longer on it.

const BISHOP = { id: "bishop-9c1d", name: "BISHOP" };

async function reassignSetup() {
  const env = await notifyServer();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, state: "idle", crew: RIPLEY }));
  writeFileSync(join(dir, `${WORKER2}.json`), valid({ sessionId: WORKER2, state: "idle", crew: BISHOP }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  const { cardId } = (await (await env.post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  await env.post("/action/card-assign", { cardId, sessionId: WORKER });
  env.sent.length = 0;
  return { ...env, cardId };
}

test("reassigning A -> B tells A once to stop, and the scrum master FYI", async () => {
  const { server, post, sent, cardId } = await reassignSetup();
  expect((await (await post("/action/card-assign", { cardId, sessionId: WORKER2 })).json()).ok).toBe(true);
  const toA = sent.filter((s) => s.sessionId === WORKER);
  expect(toA.length).toBe(1);
  expect(toA[0]!.text.startsWith("[THE LINE]")).toBe(true);
  expect(toA[0]!.text).toContain("taken off");
  expect(toA[0]!.text).toContain(cardId);
  expect(toA[0]!.text).toContain("no reply needed");
  expect(sent.filter((s) => s.sessionId === SCRUM).length).toBe(1);
  expect(sent.filter((s) => s.sessionId === WORKER2).length).toBe(0);
  server.stop(true);
});

test("unassigning A tells A once to stop", async () => {
  const { server, post, sent, cardId } = await reassignSetup();
  expect((await (await post("/action/card-assign", { cardId, sessionId: null })).json()).ok).toBe(true);
  const toA = sent.filter((s) => s.sessionId === WORKER);
  expect(toA.length).toBe(1);
  expect(toA[0]!.text).toContain("taken off");
  expect(sent.filter((s) => s.sessionId === SCRUM).length).toBe(1);
  server.stop(true);
});

test("re-assigning the same agent (or a fresh card) tells nobody", async () => {
  const { server, post, sent, cardId } = await reassignSetup();
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  expect(sent).toEqual([]);
  const { cardId: other } = (await (await post("/action/card-add", { columnId: "backlog", title: "T2" })).json()) as any;
  await post("/action/card-assign", { cardId: other, sessionId: WORKER2 });
  expect(sent).toEqual([]);
  server.stop(true);
});

test("after a reassign, A's write signed as: assignee with its crew is refused, not signed as B", async () => {
  const { server, post, cardId } = await reassignSetup();
  await post("/action/card-assign", { cardId, sessionId: WORKER2 });
  const c = await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "still on it" });
  expect(c.status).toBe(409);
  expect(((await c.json()) as any).error).toContain("no longer assigned");
  const m = await post("/action/card-move", { cardId, as: "assignee", crew: RIPLEY.id, toColumnId: "review" });
  expect(m.status).toBe(409);
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect((card.comments ?? []).some((k) => k.text === "still on it")).toBe(false);
  expect(card.columnId).toBe("backlog");
  // the new assignee signing the same way is fine, and signs as itself
  const ok = await post("/action/card-comment", { cardId, as: "assignee", crew: BISHOP.id, text: "mine now" });
  expect(ok.status).toBe(200);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.comments!.at(-1)!.author).toBe("BISHOP");
  server.stop(true);
});

// The MCP tools sign on-card writes `as: "assignee"` too. With the crew id
// from the launch env riding along, a removed agent's MCP write gets the same
// 409 as the curl footer's, rather than landing under the new assignee's name.
test("after a reassign, A's MCP comment on its spawned-for card is refused with 409", async () => {
  const { server, post, cardId } = await reassignSetup();
  await post("/action/card-assign", { cardId, sessionId: WORKER2 });
  const { handleMessage } = await import("../src/lib/mcp");
  const base = `http://localhost:${server.port}`;
  const posted: { status: number; body: any }[] = [];
  const api = {
    async get(path: string) { const r = await fetch(`${base}${path}`); return { status: r.status, body: await r.json() }; },
    async post(path: string, body: unknown) { const r = await post(path, body as object); const out = { status: r.status, body: await r.json() }; posted.push(out); return out; },
  };
  const res = (await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_comment", arguments: { cardId, text: "still on it" } } },
    { api, url: base, card: cardId, crew: RIPLEY.id },
  )) as any;
  expect(posted[0]!.status).toBe(409);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("no longer assigned");
  expect((readSnapshot(dir, Date.now()).board.cards[0]!.comments ?? []).some((k) => k.text === "still on it")).toBe(false);
  server.stop(true);
});

test("send-task bakes the agent's crew id into the footer's signed writes", async () => {
  const { server, post, sent, cardId } = await reassignSetup();
  await post("/action/send-task", { cardId });
  expect(sent[0]!.text).toContain(`"as":"assignee","crew":"${RIPLEY.id}"`);
  server.stop(true);
});

// The fallback is for a fresh spawn whose card isn't bound to it yet: its
// author + crew is accepted while that spawn is pending for the card.
test("the footer's fallback works for a pending spawn: author + crew signs as the author", async () => {
  let crewId = "";
  const { server, post } = await notifyServer({
    spawn: async (cwd: string, _task: string, o?: any) => { crewId = o?.crew?.id ?? ""; return { ok: true, cwd }; },
  });
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await post("/action/spawn", { cwd: dir, text: "go", cardId })).status).toBe(200);
  expect(crewId).not.toBe("");
  expect((await post("/action/card-comment", { cardId, as: "assignee", crew: crewId, text: "hi" })).status).toBe(400);
  const r = await post("/action/card-comment", { cardId, author: "RIPLEY", crew: crewId, text: "hi" });
  expect(r.status).toBe(200);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.comments!.at(-1)!.author).toBe("RIPLEY");
  server.stop(true);
});

// Only a crew that was taken off this card is refused. One that was never on
// it (a stale footer, a scrum master) still signs by the fallback.
test("the footer's fallback on an unassigned card works for a crew never taken off it", async () => {
  const { server, post } = await notifyServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  expect((await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "hi" })).status).toBe(400);
  expect((await post("/action/card-comment", { cardId, author: "RIPLEY", crew: RIPLEY.id, text: "hi" })).status).toBe(200);
  expect((await post("/action/card-move", { cardId, author: "RIPLEY", crew: RIPLEY.id, toColumnId: "review" })).status).toBe(200);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.comments!.at(-1)!.author).toBe("RIPLEY");
  server.stop(true);
});

// Taken off by an unassign, A's next "as" write gets the no-assignee 400 and
// the footer says to resend with author: that resend still carries its crew.
test("after an unassign, A's write is refused whatever it signs with", async () => {
  const { server, post, cardId } = await reassignSetup();
  await post("/action/card-assign", { cardId, sessionId: null });
  for (const sig of [{ as: "assignee", crew: RIPLEY.id }, { author: "RIPLEY", crew: RIPLEY.id }, { crew: RIPLEY.id }, { sessionId: WORKER }]) {
    const m = await post("/action/card-move", { cardId, ...sig, toColumnId: "review" });
    expect(m.status).toBe(409);
    expect(((await m.json()) as any).error).toContain("no longer assigned");
    expect((await post("/action/card-comment", { cardId, ...sig, text: "still on it" })).status).toBe(409);
  }
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.columnId).toBe("backlog");
  expect((card.comments ?? []).some((k) => k.text === "still on it")).toBe(false);
  server.stop(true);
});

test("after a reassign, A's write signed by author + crew or by session is refused", async () => {
  const { server, post, cardId } = await reassignSetup();
  await post("/action/card-assign", { cardId, sessionId: WORKER2 });
  for (const sig of [{ author: "RIPLEY", crew: RIPLEY.id }, { crew: RIPLEY.id }, { sessionId: WORKER }]) {
    expect((await post("/action/card-comment", { cardId, ...sig, text: "still on it" })).status).toBe(409);
    expect((await post("/action/card-move", { cardId, ...sig, toColumnId: "review" })).status).toBe(409);
  }
  // B signing any of those ways is fine
  expect((await post("/action/card-comment", { cardId, sessionId: WORKER2, text: "mine" })).status).toBe(200);
  expect((await post("/action/card-comment", { cardId, author: "BISHOP", crew: BISHOP.id, text: "mine" })).status).toBe(200);
  server.stop(true);
});

test("writes with no crew (the human's) and the scrum master's are not refused", async () => {
  const { server, post, cardId } = await reassignSetup();
  await post("/action/card-assign", { cardId, sessionId: null });
  expect((await post("/action/card-comment", { cardId, author: "You", text: "note" })).status).toBe(200);
  expect((await post("/action/card-move", { cardId, author: "You", toColumnId: "review" })).status).toBe(200);
  // The scrum master comments on cards it isn't assigned to, by crew or session.
  expect((await post("/action/card-comment", { cardId, author: "CADENCE", crew: "cadence-0001", text: "status?" })).status).toBe(200);
  expect((await post("/action/card-comment", { cardId, sessionId: SCRUM, text: "status?" })).status).toBe(200);
  // DALLAS signs by name, with or without its crew id, on cards it isn't on.
  expect((await post("/action/card-comment", { cardId, author: "DALLAS", text: "status?" })).status).toBe(200);
  expect((await post("/action/card-comment", { cardId, author: "DALLAS", crew: "dallas-0002", text: "status?" })).status).toBe(200);
  expect((await post("/action/card-move", { cardId, author: "DALLAS", crew: "dallas-0002", toColumnId: "in-progress" })).status).toBe(200);
  server.stop(true);
});

test("the same writes from the scrum master are fine while another agent is assigned", async () => {
  const { server, post, cardId } = await reassignSetup();
  expect((await post("/action/card-comment", { cardId, author: "DALLAS", crew: "dallas-0002", text: "status?" })).status).toBe(200);
  expect((await post("/action/card-comment", { cardId, author: "You", text: "note" })).status).toBe(200);
  // the assignee itself, any convention
  expect((await post("/action/card-comment", { cardId, author: "RIPLEY", crew: RIPLEY.id, text: "mine" })).status).toBe(200);
  expect((await post("/action/card-comment", { cardId, sessionId: WORKER, text: "mine" })).status).toBe(200);
  server.stop(true);
});

test("an agent put back on a card it was taken off can write again", async () => {
  const { server, post, cardId } = await reassignSetup();
  await post("/action/card-assign", { cardId, sessionId: WORKER2 });
  expect((await post("/action/card-comment", { cardId, author: "RIPLEY", crew: RIPLEY.id, text: "x" })).status).toBe(409);
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  expect((await post("/action/card-comment", { cardId, author: "RIPLEY", crew: RIPLEY.id, text: "back" })).status).toBe(200);
  // and now BISHOP is the one taken off
  expect((await post("/action/card-comment", { cardId, sessionId: WORKER2, text: "x" })).status).toBe(409);
  server.stop(true);
});

// The taken-off list is stored on the card, so a new server instance reading
// the same board from disk still refuses the removed crew.
test("after a server restart, a crew taken off the card is still refused", async () => {
  const first = await reassignSetup();
  await first.post("/action/card-assign", { cardId: first.cardId, sessionId: WORKER2 });
  first.server.stop(true);
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { deliver: async () => ({ ok: true }), deliverFresh: async () => ({ ok: true }) });
  const post = (path: string, body: object) =>
    fetch(`http://localhost:${server.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const sig of [{ as: "assignee", crew: RIPLEY.id }, { author: "RIPLEY", crew: RIPLEY.id }, { sessionId: WORKER }]) {
    const c = await post("/action/card-comment", { cardId: first.cardId, ...sig, text: "still on it" });
    expect(c.status).toBe(409);
    expect(((await c.json()) as any).error).toContain("no longer assigned");
  }
  expect((await post("/action/card-comment", { cardId: first.cardId, author: "BISHOP", crew: BISHOP.id, text: "mine" })).status).toBe(200);
  server.stop(true);
});

test("being taken off one card doesn't block writes to another", async () => {
  const { server, post, cardId } = await reassignSetup();
  await post("/action/card-assign", { cardId, sessionId: null });
  const { cardId: other } = (await (await post("/action/card-add", { columnId: "backlog", title: "Other" })).json()) as any;
  expect((await post("/action/card-comment", { cardId: other, author: "RIPLEY", crew: RIPLEY.id, text: "hi" })).status).toBe(200);
  server.stop(true);
});

// MCP on a card it wasn't spawned for signs by session. The crew id rides
// along, so a removed agent is refused there too.
test("after an unassign, A's MCP card_move on a card it wasn't spawned for is refused with 409", async () => {
  const { server, post, cardId } = await reassignSetup();
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, state: "idle", crew: RIPLEY, cwd: "/work/ripley" }));
  await post("/action/card-assign", { cardId, sessionId: null });
  const { handleMessage } = await import("../src/lib/mcp");
  const base = `http://localhost:${server.port}`;
  const posted: { status: number; body: any; sent: any }[] = [];
  const api = {
    async get(path: string) { const r = await fetch(`${base}${path}`); return { status: r.status, body: await r.json() }; },
    async post(path: string, body: unknown) { const r = await post(path, body as object); const out = { status: r.status, body: await r.json(), sent: body }; posted.push(out); return out; },
  };
  const res = (await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_move", arguments: { cardId, toColumnId: "review" } } },
    { api, url: base, card: "card_other", crew: RIPLEY.id, cwd: "/work/ripley" },
  )) as any;
  expect(posted[0]!.sent.crew).toBe(RIPLEY.id);
  expect(posted[0]!.status).toBe(409);
  expect(res.result.isError).toBe(true);
  expect(readSnapshot(dir, Date.now()).board.cards[0]!.columnId).toBe("backlog");
  server.stop(true);
});

test("GET / before the UI is built says to build it, not a bare not found", async () => {
  // A fresh worktree's `bun run dev` serves before dist/ exists; the window
  // then showed only "not found", which read as a broken route.
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const distDir = join(dir, "no-dist");
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { distDir });
  try {
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("bun run build");
    // a missing asset is still a plain 404
    const asset = await fetch(`http://localhost:${server.port}/nope.js`);
    expect(asset.status).toBe(404);
  } finally {
    server.stop(true);
  }
});

test("GET / serves dist/index.html once built", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const distDir = join(dir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<p>built</p>");
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { distDir });
  try {
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>built</p>");
  } finally {
    server.stop(true);
  }
});
