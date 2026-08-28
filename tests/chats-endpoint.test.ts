import { test, expect } from "bun:test";
import { searchChats } from "../src/server";
import type { ChatMessage } from "../src/lib/conversation";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = "/tmp/aw-chats-test";
function reset() { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
const valid = (o: object) => JSON.stringify({
  sessionId: "s", name: "A", role: "r", ticket: null, state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 9_999_999_999_999, ...o,
});

// Injected conversation reader: return canned messages per session, no filesystem.
const reader = (msgs: Record<string, ChatMessage[]>) =>
  async (sid: string) => ({ messages: msgs[sid] ?? [] });

test("searchChats returns a hit per live session whose transcript mentions the query", async () => {
  reset();
  writeFileSync(join(dir, "aaa.json"), valid({ sessionId: "aaa", name: "SABLE" }));
  writeFileSync(join(dir, "bbb.json"), valid({ sessionId: "bbb", name: "ANVIL" }));
  const hits = await searchChats(dir, "accordion", Date.now(), reader({
    aaa: [{ role: "user", text: "the accordion keeps collapsing" }],
    bbb: [{ role: "user", text: "unrelated chatter" }],
  }));
  expect(hits.map((h) => h.sessionId)).toEqual(["aaa"]);
  expect(hits[0]!.name).toBe("SABLE");
  expect(hits[0]!.snippet.toLowerCase()).toContain("accordion");
});

test("searchChats returns nothing for a blank query without reading transcripts", async () => {
  reset();
  writeFileSync(join(dir, "aaa.json"), valid({ sessionId: "aaa", name: "SABLE" }));
  let read = 0;
  const hits = await searchChats(dir, "   ", Date.now(), async (sid) => { read++; return { messages: [] }; });
  expect(hits).toEqual([]);
  expect(read).toBe(0);
});

test("GET /search returns chat hits from live sessions", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  writeFileSync(join(dir, "ccc.json"), valid({ sessionId: "ccc", name: "SABLE" }));
  // point the projects dir at a fixture with one transcript for session ccc
  const proj = "/tmp/aw-chats-projects";
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(join(proj, "someproj"), { recursive: true });
  writeFileSync(
    join(proj, "someproj", "ccc.jsonl"),
    JSON.stringify({ type: "user", message: { content: "please look at the widget alignment" } }) + "\n",
  );
  process.env.AGENT_PROJECTS_DIR = proj;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/search?q=widget`);
  const out = (await res.json()) as { chats: { sessionId: string; snippet: string }[] };
  expect(out.chats.map((c) => c.sessionId)).toEqual(["ccc"]);
  expect(out.chats[0]!.snippet.toLowerCase()).toContain("widget");
  server.stop(true);
});

test("GET /search with a blank query returns an empty list", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/search?q=`);
  expect((await res.json())).toEqual({ chats: [] });
  server.stop(true);
});
