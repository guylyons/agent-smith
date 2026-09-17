// tests/mcp-stdio.test.ts — end to end over the real transport: a spawned
// `bun run src/mcp.ts` talking newline-delimited JSON-RPC on stdio to a real
// dashboard server, writing a real board file. This is the part unit tests
// can't prove: that a client can actually handshake with us and get replies.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = fixtureDir("mcp-stdio-test");

let server: ReturnType<typeof import("../src/server").makeServer>;
let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
let reader: ReadableStreamDefaultReader<Uint8Array>;
let url = "";
let previousStatusDir: string | undefined;

// Both the dashboard and the MCP process live for the whole file (one client
// session, several calls) — and neither outlives it: a stray server or child
// process would go on competing for CPU with every test file that runs after.
beforeAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  previousStatusDir = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = dir;

  const { makeServer } = await import("../src/server");
  server = makeServer(0);
  url = `http://localhost:${server.port}`;

  child = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "mcp.ts")], {
    env: { ...process.env, AGENT_WORKSHOP_URL: url, AGENT_WORKSHOP_AUTHOR: "ANVIL" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  reader = child.stdout.getReader();
});

afterAll(async () => {
  child.kill();
  await child.exited; // don't leave it winding down into the next file
  server.stop(true);
  if (previousStatusDir === undefined) delete process.env.AGENT_STATUS_DIR;
  else process.env.AGENT_STATUS_DIR = previousStatusDir;
});

let buffered = "";
/** Read one newline-delimited JSON message off the child's stdout. */
async function readMessage(): Promise<any> {
  while (!buffered.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("mcp server closed stdout");
    buffered += new TextDecoder().decode(value);
  }
  const line = buffered.slice(0, buffered.indexOf("\n"));
  buffered = buffered.slice(buffered.indexOf("\n") + 1);
  return JSON.parse(line);
}
const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");

test("a client can handshake, list tools, and drive a card end to end", async () => {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  const init = await readMessage();
  expect(init.id).toBe(1);
  expect(init.result.serverInfo.name).toBe("the-line");

  // A notification must draw no reply at all — if it did, the next read below
  // would return it instead of the tools/list result.
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await readMessage();
  expect(list.id).toBe(2);
  expect(list.result.tools.map((t: any) => t.name)).toContain("card_create");

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "card_create", arguments: { columnId: "backlog", title: "From MCP", description: "d" } } });
  const created = await readMessage();
  const cardId = (created.result.content[0].text as string).match(/card_[0-9a-f]+/)![0];

  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "card_comment", arguments: { cardId, text: "picked up" } } });
  expect((await readMessage()).result.isError).toBeUndefined();

  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "card_move", arguments: { cardId, toColumnId: "review" } } });
  expect((await readMessage()).result.isError).toBeUndefined();

  // The board the dashboard actually persisted reflects all three calls, and
  // the comment is signed with the author from the environment.
  const board = (await (await fetch(`${url}/board`)).json()) as any;
  const card = board.board.cards.find((c: any) => c.id === cardId);
  expect(card.title).toBe("From MCP");
  expect(card.columnId).toBe("review");
  expect(card.comments[0].author).toBe("ANVIL");

  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "board_read", arguments: {} } });
  expect((await readMessage()).result.content[0].text).toContain(cardId);
}, 15_000);

test("a malformed line does not kill the server", async () => {
  child.stdin.write("this is not json\n");
  send({ jsonrpc: "2.0", id: 7, method: "ping" });
  const pong = await readMessage();
  expect(pong.id).toBe(7);
  expect(pong.result).toEqual({});
}, 10_000);
