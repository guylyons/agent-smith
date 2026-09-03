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

test("POST /action/board persists the board, visible in the snapshot", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const board = {
    columns: [{ id: "c1", name: "Todo", instruction: "do it" }],
    cards: [{ id: "k1", title: "task", columnId: "c1" }],
  };
  const res = await fetch(`http://localhost:${server.port}/action/board`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ board }),
  });
  expect((await res.json()).ok).toBe(true);
  const snap = readSnapshot(dir, Date.now());
  expect(snap.board.columns.map((c) => c.name)).toEqual(["Todo"]);
  expect(snap.board.cards.map((c) => c.title)).toEqual(["task"]);
  server.stop(true);
});

test("POST /action/board sanitizes a malformed board before storing", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const board = {
    columns: [{ id: "c1", name: "Todo", instruction: "" }],
    cards: [{ id: "k1", title: "orphan", columnId: "ghost" }], // unknown column -> dropped
  };
  const res = await fetch(`http://localhost:${server.port}/action/board`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ board }),
  });
  expect((await res.json()).ok).toBe(true);
  expect(readSnapshot(dir, Date.now()).board.cards).toEqual([]);
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

test("GET /uploads serves a saved image back, and refuses a traversal", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  process.env.AGENT_UPLOAD_DIR = "/tmp/aw-server-upload-serve-test";
  rmSync("/tmp/aw-server-upload-serve-test", { recursive: true, force: true });
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
  expect(list.map((p) => p.id)).toEqual(["backend-dev", "editor", "frontend-ux", "scrum-master"]);
  expect(list[0].name).toBeUndefined(); // a persona is a role; the crew member brings the name
  expect(list[0].role).toBeTruthy();
  expect(Array.isArray(list[0].skills)).toBe(true);
  expect(list[0].prompt).toBeUndefined();
  srv.stop();
});

test("readSnapshot resolves a persona onto the agent", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", persona: "backend-dev", name: "NOVA", role: "General" }));
  const [agent] = readSnapshot(dir, Date.now()).agents;
  expect(agent.name).toBe("NOVA"); // the shipped personas carry no name
  expect(agent.role).toBe("Backend Dev");
  // the shipped personas carry no sprite either: the look follows the crew name
  expect(agent.sprite).toBeUndefined();
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
  const scanDir = "/tmp/aw-server-test-scan";
  rmSync(scanDir, { recursive: true, force: true });
  mkdirSync(scanDir, { recursive: true });
  process.env.AGENT_STATUS_DIR = scanDir;
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
  expect(readSnapshot(scanDir, Date.now()).agents).toEqual([]);
  process.env.AGENT_STATUS_DIR = dir;
});

// ---- the card-scoped agent API -------------------------------------------
// Agents drive their own ticket through these; each is applied server-side
// against the latest board, so concurrent writers never clobber each other.

const CARD_SESSION = "502d0e8c-8790-4804-b767-0549edfc959c";

async function cardApiServer() {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
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
  expect(out.agents[0].name).toBe("A");
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

async function notifyServer(opts: { deliverOk?: boolean; deliverFreshOk?: boolean } = {}) {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const sent: { sessionId: string; text: string; fresh: boolean }[] = [];
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, {
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
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", crew: { id: "cadence-0001", name: "CADENCE" }, state: "idle" }));
  // the fs watcher (debounced) notices the file and the next push flushes
  for (let i = 0; i < 40 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  expect(sent.map((s) => s.sessionId)).toEqual([SCRUM]);
  expect(sent[0]!.text).toContain("note");
  expect(((await (await post("/action/inbox-drain", { sessionId: SCRUM })).json()) as any).items).toEqual([]);
  server.stop(true);
});

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
const mergeRepo = "/tmp/aw-server-merge-repo";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

/** A throwaway repo with a linked worktree holding one committed change, plus a
 *  status file pointing a session at that worktree. Returns the card id of a
 *  card assigned to it. */
async function mergeFixture(post: (p: string, b: object) => Promise<Response>): Promise<string> {
  rmSync(mergeRepo, { recursive: true, force: true });
  mkdirSync(mergeRepo, { recursive: true });
  await git(mergeRepo, "init", "-q", "-b", "main");
  await git(mergeRepo, "config", "user.email", "t@t");
  await git(mergeRepo, "config", "user.name", "t");
  writeFileSync(join(mergeRepo, "README"), "root\n");
  await git(mergeRepo, "add", "-A");
  await git(mergeRepo, "commit", "-q", "-m", "root");
  const wt = join(mergeRepo, "wt");
  await git(mergeRepo, "worktree", "add", "-q", "-b", "feature", wt, "HEAD");
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

test("GET /merge-state explains a card with nowhere to merge from", async () => {
  const { server, base, post } = await cardApiServer();
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Unassigned" })).json()) as any;
  expect((await fetch(`${base}/merge-state?cardId=${cardId}`)).status).toBe(400); // no assignee
  expect((await fetch(`${base}/merge-state?cardId=card_nope`)).status).toBe(404);
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
