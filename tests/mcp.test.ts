// tests/mcp.test.ts — the board MCP server's protocol + tool layer. The HTTP
// side is injected, so every case runs without a dashboard or a subprocess.
import { test, expect } from "bun:test";
import { handleMessage, TOOLS, formatBoard, formatCard, type Api, type Ctx } from "../src/lib/mcp";

const board = {
  columns: [
    { id: "backlog", name: "Backlog", instruction: "" },
    { id: "review", name: "Review", instruction: "tests must be green" },
  ],
  cards: [
    { id: "card_1", title: "Fix login", columnId: "backlog", description: "it 500s", comments: [{ id: "c1", author: "VOLT", text: "on it", at: 0 }] },
    { id: "card_2", title: "Ship it", columnId: "review", assignee: { id: "sess-1", name: "ANVIL" } },
  ],
};

/** An Api that records calls and replays canned replies keyed by path. */
function fakeApi(replies: Record<string, { status: number; body: any }> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const reply = (path: string) => replies[path] ?? { status: 200, body: { ok: true } };
  const api: Api = {
    async get(path) { calls.push({ method: "GET", path }); return reply(path); },
    async post(path, body) { calls.push({ method: "POST", path, body }); return reply(path); },
  };
  return { api, calls };
}

const ctx = (api: Api): Ctx => ({ api, author: "ANVIL", url: "http://localhost:4173" });

const call = (name: string, args: object, api: Api) =>
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ctx(api)) as Promise<any>;

test("initialize answers with the client's protocol version and a tools capability", async () => {
  const { api } = fakeApi();
  const res = (await handleMessage(
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    ctx(api),
  )) as any;
  expect(res.id).toBe(0);
  expect(res.result.protocolVersion).toBe("2024-11-05");
  expect(res.result.capabilities.tools).toBeDefined();
  expect(res.result.serverInfo.name).toBe("the-line");
});

test("initialize falls back to our own version when the client's is unknown", async () => {
  const { api } = fakeApi();
  const res = (await handleMessage(
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    ctx(api),
  )) as any;
  expect(res.result.protocolVersion).toBe("2025-06-18");
});

test("a notification (no id) gets no reply", async () => {
  const { api } = fakeApi();
  expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx(api))).toBe(null);
});

test("tools/list returns every board tool with an object input schema", async () => {
  const { api } = fakeApi();
  const res = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx(api))) as any;
  const names = res.result.tools.map((t: any) => t.name);
  expect(names).toEqual(TOOLS.map((t) => t.name));
  expect(names).toContain("card_create");
  for (const t of res.result.tools) {
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.inputSchema.type).toBe("object");
  }
});

test("an unknown method is a JSON-RPC method-not-found error", async () => {
  const { api } = fakeApi();
  const res = (await handleMessage({ jsonrpc: "2.0", id: 3, method: "nope/nope" }, ctx(api))) as any;
  expect(res.error.code).toBe(-32601);
});

test("card_create posts to card-add and reports the new card id", async () => {
  const { api, calls } = fakeApi({ "/action/card-add": { status: 200, body: { ok: true, cardId: "card_9" } } });
  const res = await call("card_create", { columnId: "backlog", title: "New", description: "d" }, api);
  expect(calls).toEqual([{ method: "POST", path: "/action/card-add", body: { columnId: "backlog", title: "New", description: "d" } }]);
  expect(res.result.isError).toBeUndefined();
  expect(res.result.content[0].text).toContain("card_9");
});

test("card_comment defaults the author to this agent's board name", async () => {
  const { api, calls } = fakeApi();
  await call("card_comment", { cardId: "card_1", text: "done" }, api);
  expect(calls[0]!.body).toEqual({ cardId: "card_1", author: "ANVIL", text: "done" });
});

test("card_comment uses an explicit author when given one", async () => {
  const { api, calls } = fakeApi();
  await call("card_comment", { cardId: "card_1", author: "CADENCE", text: "hi" }, api);
  expect((calls[0]!.body as any).author).toBe("CADENCE");
});

test("card_update sends only the fields it was given", async () => {
  const { api, calls } = fakeApi();
  await call("card_update", { cardId: "card_1", description: "new detail" }, api);
  expect(calls[0]!.body).toEqual({ cardId: "card_1", description: "new detail" });
});

test("card_assign passes null through to unassign", async () => {
  const { api, calls } = fakeApi();
  await call("card_assign", { cardId: "card_1", sessionId: null }, api);
  expect(calls[0]!.body).toEqual({ cardId: "card_1", sessionId: null });
});

test("a missing required argument is a tool error, not a request to the server", async () => {
  const { api, calls } = fakeApi();
  const res = await call("card_move", { cardId: "card_1" }, api);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("toColumnId");
  expect(calls).toEqual([]);
});

test("an unknown tool is a tool error naming the tool", async () => {
  const { api } = fakeApi();
  const res = await call("card_yeet", { cardId: "x" }, api);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("card_yeet");
});

test("a rejection from the dashboard comes back as the tool's error text", async () => {
  const { api } = fakeApi({ "/action/card-move": { status: 400, body: { ok: false, error: "unknown column: ghost" } } });
  const res = await call("card_move", { cardId: "card_1", toColumnId: "ghost" }, api);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("unknown column: ghost");
});

test("an unreachable dashboard is a tool error saying how to start it", async () => {
  const api: Api = {
    async get() { throw new Error("ECONNREFUSED"); },
    async post() { throw new Error("ECONNREFUSED"); },
  };
  const res = await call("board_read", {}, api);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("http://localhost:4173");
  expect(res.result.content[0].text).toContain("bun run dev");
});

test("board_read renders one compact line per card under its column", async () => {
  const { api } = fakeApi({ "/board": { status: 200, body: { board } } });
  const res = await call("board_read", {}, api);
  const text = res.result.content[0].text as string;
  expect(text).toContain("Backlog (backlog)");
  expect(text).toContain("card_1");
  expect(text).toContain("Fix login");
  expect(text).toContain("ANVIL"); // assignee shown
  expect(text).toContain("tests must be green"); // column instruction shown
});

test("board_read stays a digest: no descriptions or comment bodies", async () => {
  const text = formatBoard(board as any);
  expect(text).not.toContain("it 500s");
  expect(text).not.toContain("on it");
  expect(text).toContain("1 comment");
});

test("formatBoard names an empty column rather than dropping it", () => {
  const text = formatBoard({ columns: [{ id: "done", name: "Done", instruction: "" }], cards: [] } as any);
  expect(text).toContain("Done (done)");
  expect(text).toContain("(empty)");
});

test("card_read shows the full card: description, assignee and comment bodies", async () => {
  const { api } = fakeApi({ "/board": { status: 200, body: { board } } });
  const res = await call("card_read", { cardId: "card_1" }, api);
  const text = res.result.content[0].text as string;
  expect(text).toContain("it 500s");
  expect(text).toContain("VOLT");
  expect(text).toContain("on it");
  expect(text).toContain("backlog");
});

test("card_read on an unknown card is a tool error", async () => {
  const { api } = fakeApi({ "/board": { status: 200, body: { board } } });
  const res = await call("card_read", { cardId: "card_nope" }, api);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("card_nope");
});

test("agents_list shows who a card can be assigned to", async () => {
  const agents = [{ sessionId: "sess-1", name: "ANVIL", role: "Backend Dev", state: "idle", doing: "waiting" }];
  const { api } = fakeApi({ "/agents": { status: 200, body: { agents } } });
  const res = await call("agents_list", {}, api);
  const text = res.result.content[0].text as string;
  expect(text).toContain("sess-1");
  expect(text).toContain("ANVIL");
  expect(text).toContain("idle");
});

test("agents_list says so when nothing is running", async () => {
  const { api } = fakeApi({ "/agents": { status: 200, body: { agents: [] } } });
  const res = await call("agents_list", {}, api);
  expect(res.result.content[0].text).toContain("No live agents");
});

// --- who a comment is signed by -------------------------------------------
// A session can't know its own board codename, and one env var can't name
// every session, so an unset author is resolved to the live agent running in
// this very folder — by SESSION id, and the server puts the current desk name
// on it, so a rename or a persona can never mis-sign the note.

test("an unset author resolves to the live agent working in this folder", async () => {
  const agents = [
    { sessionId: "s1", name: "VOLT", role: "r", state: "working", doing: "x", cwd: "/w/one" },
    { sessionId: "s2", name: "ANVIL", role: "r", state: "working", doing: "x", cwd: "/w/two" },
  ];
  const { api, calls } = fakeApi({ "/agents": { status: 200, body: { agents } } });
  const res = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_comment", arguments: { cardId: "card_1", text: "hi" } } },
    { api, url: "http://localhost:4173", cwd: "/w/two" },
  ) as any;
  expect(res.result.isError).toBeUndefined();
  expect((calls.find((c) => c.path === "/action/card-comment")!.body as any).sessionId).toBe("s2");
});

test("an ambiguous folder falls back to a generic author rather than guessing", async () => {
  const agents = [
    { sessionId: "s1", name: "VOLT", role: "r", state: "working", doing: "x", cwd: "/w/one" },
    { sessionId: "s2", name: "ANVIL", role: "r", state: "working", doing: "x", cwd: "/w/one" },
  ];
  const { api, calls } = fakeApi({ "/agents": { status: 200, body: { agents } } });
  await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_comment", arguments: { cardId: "card_1", text: "hi" } } },
    { api, url: "http://localhost:4173", cwd: "/w/one" },
  );
  expect((calls.find((c) => c.path === "/action/card-comment")!.body as any).author).toBe("Claude");
});

test("the resolved author is looked up once, not on every call", async () => {
  const agents = [{ sessionId: "s1", name: "VOLT", role: "r", state: "working", doing: "x", cwd: "/w/one" }];
  const { api, calls } = fakeApi({ "/agents": { status: 200, body: { agents } } });
  const c: Ctx = { api, url: "http://localhost:4173", cwd: "/w/one" };
  const msg = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "card_comment", arguments: { cardId: "card_1", text: "hi" } } });
  await handleMessage(msg(1), c);
  await handleMessage(msg(2), c);
  expect(calls.filter((x) => x.path === "/agents").length).toBe(1);
});

// --- signing as the card's assignee ----------------------------------------
// A session spawned for a card inherits AGENT_CARD; on that card it signs
// `as: "assignee"` and the server resolves the name — no guessing from cwd,
// no persona name that disagrees with a renamed desk.

test("a session spawned for a card signs writes on THAT card as its assignee", async () => {
  const { api, calls } = fakeApi();
  const c: Ctx = { api, url: "http://localhost:4173", cwd: "/w/one", card: "card_1" };
  await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_comment", arguments: { cardId: "card_1", text: "hi" } } }, c);
  await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "card_move", arguments: { cardId: "card_1", toColumnId: "review" } } }, c);
  const comment = calls.find((x) => x.path === "/action/card-comment")!.body as any;
  const move = calls.find((x) => x.path === "/action/card-move")!.body as any;
  expect(comment.as).toBe("assignee");
  expect(comment.author).toBeUndefined();
  expect(move.as).toBe("assignee");
  expect(calls.some((x) => x.path === "/agents")).toBe(false); // nothing to look up
});

test("on another card the same session falls back to its own identity", async () => {
  const agents = [{ sessionId: "s1", name: "VOLT", role: "r", state: "working", doing: "x", cwd: "/w/one" }];
  const { api, calls } = fakeApi({ "/agents": { status: 200, body: { agents } } });
  const c: Ctx = { api, url: "http://localhost:4173", cwd: "/w/one", card: "card_1" };
  await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_comment", arguments: { cardId: "card_2", text: "hi" } } }, c);
  const comment = calls.find((x) => x.path === "/action/card-comment")!.body as any;
  expect(comment.as).toBeUndefined();
  expect(comment.sessionId).toBe("s1"); // by session, so a rename can't mis-sign it
});

test("a lone session in its folder signs by session id, an explicit author still wins", async () => {
  const agents = [{ sessionId: "s1", name: "VOLT", role: "r", state: "working", doing: "x", cwd: "/w/one" }];
  const { api, calls } = fakeApi({ "/agents": { status: 200, body: { agents } } });
  await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_comment", arguments: { cardId: "card_1", text: "hi" } } },
    { api, url: "http://localhost:4173", cwd: "/w/one" },
  );
  await handleMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "card_comment", arguments: { cardId: "card_1", text: "hi", author: "CADENCE" } } },
    { api, url: "http://localhost:4173", cwd: "/w/one" },
  );
  const [first, second] = calls.filter((x) => x.path === "/action/card-comment").map((x) => x.body as any);
  expect(first.sessionId).toBe("s1");
  expect(first.author).toBeUndefined();
  expect(second.author).toBe("CADENCE");
  expect(second.sessionId).toBeUndefined();
});

// ---- crew_note: a crew member's notes for its future self -------------------

test("tools/list includes crew_note", async () => {
  expect(TOOLS.map((t) => t.name)).toContain("crew_note");
});

test("crew_note signs by the crew id from the launch env and reads the notes back", async () => {
  const { api, calls } = fakeApi({ "/action/crew-note": { status: 200, body: { ok: true, notes: "tests live in tests/\n" } } });
  const c: Ctx = { api, url: "http://localhost:4173", cwd: "/w/one", crew: "ripley-3f2a" };
  const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crew_note", arguments: { text: "tests live in tests/" } } }, c) as any;
  expect(calls[0]!.body).toEqual({ crew: "ripley-3f2a", text: "tests live in tests/", replace: false });
  expect(res.result.content[0].text).toContain("tests live in tests/");
});

test("crew_note falls back to the spawned-for card, then the session in this folder", async () => {
  const { api, calls } = fakeApi();
  await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crew_note", arguments: { text: "n", replace: true } } },
    { api, url: "http://localhost:4173", cwd: "/w/one", card: "card_1" });
  expect(calls[0]!.body).toEqual({ cardId: "card_1", as: "assignee", text: "n", replace: true });

  const agents = [{ sessionId: "s2", name: "ANVIL", role: "r", state: "working", doing: "x", cwd: "/w/two" }];
  const second = fakeApi({ "/agents": { status: 200, body: { agents } } });
  await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crew_note", arguments: { text: "n" } } },
    { api: second.api, url: "http://localhost:4173", cwd: "/w/two" });
  expect((second.calls.find((x) => x.path === "/action/crew-note")!.body as any).sessionId).toBe("s2");
});

test("crew_note is a tool error when nobody can tell whose notes they are", async () => {
  const { api } = fakeApi({ "/agents": { status: 200, body: { agents: [] } } });
  const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crew_note", arguments: { text: "n" } } },
    { api, url: "http://localhost:4173", cwd: "/w/none" }) as any;
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("AGENT_CREW");
});

// ---- file claims ----------------------------------------------------------

test("card_update sends a touches list through to the board", async () => {
  const { api, calls } = fakeApi();
  await call("card_update", { cardId: "card_1", touches: ["src/lib/board.ts", "src/ui/*.tsx"] }, api);
  expect(calls[0]!.body).toEqual({ cardId: "card_1", touches: ["src/lib/board.ts", "src/ui/*.tsx"] });
});

test("card_update accepts an empty touches list (that is how a claim is cleared)", async () => {
  const { api, calls } = fakeApi();
  await call("card_update", { cardId: "card_1", touches: [] }, api);
  expect(calls[0]!.body).toEqual({ cardId: "card_1", touches: [] });
});

test("card_update still refuses a call with no field to change", async () => {
  const { api } = fakeApi();
  const res = await call("card_update", { cardId: "card_1" }, api);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("touches");
});

test("card_assign passes force through so a human can override a file claim", async () => {
  const { api, calls } = fakeApi();
  await call("card_assign", { cardId: "card_1", sessionId: "sess-1", force: true }, api);
  expect(calls[0]!.body).toEqual({ cardId: "card_1", sessionId: "sess-1", force: true });
});

test("card_assign leaves force out when it was not asked for", async () => {
  const { api, calls } = fakeApi();
  await call("card_assign", { cardId: "card_1", sessionId: "sess-1" }, api);
  expect(calls[0]!.body).toEqual({ cardId: "card_1", sessionId: "sess-1" });
});

test("card_assign surfaces the board's refusal when a claim is in the way", async () => {
  const { api } = fakeApi({
    "/action/card-assign": { status: 409, body: { ok: false, error: "card_9 already claims src/ui/TheLine.tsx (in doing) - wait for it to merge, or edit touches to remove the overlap" } },
  });
  const res = await call("card_assign", { cardId: "card_1", sessionId: "sess-1" }, api);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("already claims src/ui/TheLine.tsx");
});

test("card_read shows a card's file claim, and says so when there is none", async () => {
  expect(formatCard({ ...board, cards: [{ ...board.cards[0]!, touches: ["src/lib/board.ts"] }] } as any, "card_1"))
    .toContain("touches: src/lib/board.ts");
  expect(formatCard(board as any, "card_1")).toContain("touches: (none)");
});

// ---- memory_*: the team memory (src/lib/memory.ts) ---------------------------

test("memory_search asks /memory with the query and formats the results", async () => {
  const node = { id: "mem_1234abcd", kind: "decision", title: "One merge at a time", at: 0, links: ["repo:agent-smith"] };
  const { api, calls } = fakeApi({ "/memory?q=repo%3Aagent-smith+merge&limit=5": { status: 200, body: { results: [node] } } });
  const res = await call("memory_search", { query: "repo:agent-smith merge", limit: 5 }, api);
  expect(calls[0]).toEqual({ method: "GET", path: "/memory?q=repo%3Aagent-smith+merge&limit=5" });
  expect(res.result.content[0].text).toContain("mem_1234abcd");
  expect(res.result.content[0].text).toContain("One merge at a time");
});

test("memory_search with an id shows that node and its neighbours", async () => {
  const node = { id: "card:card_1", kind: "card", title: "Fix login", at: 0 };
  const near = { id: "mem_1234abcd", kind: "gotcha", title: "Cookie path", at: 0 };
  const { api, calls } = fakeApi({ "/memory?id=card%3Acard_1": { status: 200, body: { node, neighbours: [near] } } });
  const text = (await call("memory_search", { id: "card:card_1" }, api)).result.content[0].text;
  expect(calls[0]!.path).toBe("/memory?id=card%3Acard_1");
  expect(text).toContain("Fix login");
  expect(text).toContain("Cookie path");
});

test("memory_add posts the fact signed with our name", async () => {
  const { api, calls } = fakeApi({ "/action/memory-add": { status: 200, body: { ok: true, node: { id: "mem_1234abcd", kind: "note", title: "t", at: 0 } } } });
  const res = await call("memory_add", { kind: "note", title: "t", body: "b", links: ["repo:x"], tags: ["y"] }, api);
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/action/memory-add", body: { kind: "note", title: "t", body: "b", links: ["repo:x"], tags: ["y"], author: "ANVIL" } });
  expect(res.result.content[0].text).toContain("mem_1234abcd");
});

test("memory_add without a title is a tool error and posts nothing", async () => {
  const { api, calls } = fakeApi();
  const res = await call("memory_add", { kind: "note" }, api);
  expect(res.result.isError).toBe(true);
  expect(calls).toEqual([]);
});

test("memory_forget posts the id", async () => {
  const { api, calls } = fakeApi();
  await call("memory_forget", { id: "mem_1234abcd" }, api);
  expect(calls).toEqual([{ method: "POST", path: "/action/memory-forget", body: { id: "mem_1234abcd" } }]);
});
