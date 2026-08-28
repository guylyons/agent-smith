// tests/mcp.test.ts — the board MCP server's protocol + tool layer. The HTTP
// side is injected, so every case runs without a dashboard or a subprocess.
import { test, expect } from "bun:test";
import { handleMessage, TOOLS, formatBoard, type Api, type Ctx } from "../src/lib/mcp";

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
// every session, so an unset author is resolved from the live agent running in
// this very folder.

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
  expect((calls.find((c) => c.path === "/action/card-comment")!.body as any).author).toBe("ANVIL");
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
