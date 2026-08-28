// THE LINE as an MCP server: gives any Claude session tools to read the board
// and create, move, rename, describe, assign and comment on cards — instead of
// hand-writing curl calls into the dashboard's HTTP API.
//
// Transport is stdio with newline-delimited JSON-RPC, the shape `claude mcp add`
// speaks. This file is only the I/O shell: framing, fetch, and environment.
// All the protocol and tool logic lives in src/lib/mcp.ts, where it's tested.
//
// Register it (from this repo):
//   claude mcp add --scope user the-line -- bun run <repo>/src/mcp.ts
// or, more simply:
//   bun run install-mcp
//
// Environment:
//   AGENT_WORKSHOP_URL     dashboard base URL (default http://localhost:4173)
//   AGENT_WORKSHOP_AUTHOR  the name to sign comments and moves with (optional:
//                          without it, the board codename of the agent running
//                          in this folder is used)
import { handleMessage, type Api, type Ctx } from "./lib/mcp";

const url = (process.env.AGENT_WORKSHOP_URL ?? "http://localhost:4173").replace(/\/+$/, "");
// Only set when the environment names us; otherwise our board codename is
// resolved from the live agent running in this folder (see authorFor).
const author = process.env.AGENT_WORKSHOP_AUTHOR?.trim() || undefined;

const api: Api = {
  async get(path) {
    const res = await fetch(url + path);
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  async post(path, body) {
    const res = await fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
};

const ctx: Ctx = { api, url, author, cwd: process.cwd() };

// stdout carries the protocol and nothing else — anything we want to say goes
// to stderr, or the client's parser breaks.
function reply(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk);
  let nl: number;
  while ((nl = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, nl).trim();
    buffered = buffered.slice(nl + 1);
    if (!line) continue;
    let msg: unknown;
    // A line we can't parse is skipped, not fatal: dropping one message beats
    // killing a session's only connection to the board.
    try { msg = JSON.parse(line); } catch { console.error(`[the-line] ignoring unparseable line: ${line.slice(0, 120)}`); continue; }
    // Not awaited: replies are matched by id, so a slow call never blocks the
    // next request.
    handleMessage(msg, ctx)
      .then((out) => { if (out) reply(out); })
      .catch((e) => console.error(`[the-line] ${e instanceof Error ? e.message : String(e)}`));
  }
}
