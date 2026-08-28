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
  expect(out.agents[0].name).toBe("ANVIL");
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

async function notifyServer() {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const sent: { sessionId: string; text: string; fresh: boolean }[] = [];
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, {
    deliver: async (target: any, text: string) => { sent.push({ sessionId: target.sessionId, text, fresh: false }); return { ok: true }; },
    deliverFresh: async (target: any, text: string) => { sent.push({ sessionId: target.sessionId, text, fresh: true }); return { ok: true }; },
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
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  const res = await post("/action/send-task", { cardId });
  expect(((await res.json()) as any).ok).toBe(true);
  expect(sent.length).toBe(1);
  expect(sent[0]!.sessionId).toBe(WORKER);
  expect(sent[0]!.fresh).toBe(true); // a new task clears the agent's context first
  expect(sent[0]!.text).toContain("Fix bug");
  expect(sent[0]!.text).toContain(cardId);
  expect(sent[0]!.text).toContain(`${base}/action/card-move`); // curl target is this server
  expect(sent[0]!.text).toContain('"author":"VOLT"');
  // and the thread records the send
  const card = readSnapshot(dir, Date.now()).board.cards[0]!;
  expect(card.comments!.some((c) => c.text.includes("Sent task to VOLT"))).toBe(true);
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
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT" }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master" }));
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
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "VOLT" }));
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Fix bug" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  sent.length = 0;
  // CADENCE is the scrum-master persona's display name
  await post("/action/card-comment", { cardId, author: "CADENCE", text: "please add a test" });
  expect(sent.map((s) => s.sessionId)).toEqual([WORKER]);
  expect(sent[0]!.text).toContain("please add a test");
  server.stop(true);
});

test("a worker's card-move wakes the scrum master", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master" }));
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

test("no notification is delivered to a session that is waiting on a dialog", async () => {
  const { server, post, sent } = await notifyServer();
  writeFileSync(join(dir, `${SCRUM}.json`), valid({ sessionId: SCRUM, persona: "scrum-master", state: "waiting" }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "T" })).json()) as any;
  sent.length = 0;
  await post("/action/card-comment", { cardId, author: "VOLT", text: "update" });
  await post("/action/card-move", { cardId, toColumnId: "review", author: "VOLT" });
  expect(sent).toEqual([]);
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
