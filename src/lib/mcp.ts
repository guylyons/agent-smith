// The board's MCP surface: tool definitions plus the JSON-RPC dispatch behind
// them. Everything here is pure logic over an injected `Api`, so the whole
// protocol is unit-tested without a subprocess, a socket, or a dashboard.
// `src/mcp.ts` is the thin I/O shell that wires this to stdio and fetch.
//
// Writes go through the dashboard's HTTP actions rather than the board file,
// for the same reason the agent protocol footer does: the server applies each
// card-scoped mutation against the latest board, so two writers can never
// clobber each other, and the open UI updates live.
import type { Board } from "./board";

export type ApiResult = { status: number; body: any };
export type Api = {
  get(path: string): Promise<ApiResult>;
  post(path: string, body: unknown): Promise<ApiResult>;
};
/** Everything a tool needs: how to reach the dashboard, the base URL (for the
 *  "not running" message), and who this agent is. `author` is only set when the
 *  environment names it; otherwise `cwd` identifies us — see authorFor. */
export type Ctx = {
  api: Api;
  url: string;
  author?: string;
  /** This session's folder, used to look our own board name up. */
  cwd?: string;
  /** Memo for authorFor. Resolving costs a request, and the answer can't change
   *  for the life of the process. */
  resolvedAuthor?: string;
};

/** Signed on a comment when we can't tell which agent we are. */
const UNKNOWN_AUTHOR = "Claude";

export const SERVER_NAME = "the-line";
export const SERVER_VERSION = "1.0.0";
/** Newest first — the version we answer with when a client asks for one we
 *  don't know. Every entry here is one we actually speak. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ---- talking to the dashboard --------------------------------------------

/** One dashboard call, with both failure modes turned into a plain Error whose
 *  message is what the agent should read: a refused connection becomes "start
 *  the dashboard", a 4xx becomes the server's own explanation. */
async function request(ctx: Ctx, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  let res: ApiResult;
  try {
    res = method === "GET" ? await ctx.api.get(path) : await ctx.api.post(path, body);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`the board is not reachable at ${ctx.url} (${why}). Start the dashboard with \`bun run dev\` in the agent-smith repo.`);
  }
  if (res.status >= 400 || (res.body && res.body.ok === false)) {
    throw new Error(String(res.body?.error ?? `HTTP ${res.status}`));
  }
  return res.body;
}

/** Who to sign a move or comment as. A Claude session has no way to know the
 *  codename the board shows it under, and one environment variable can't name
 *  every session, so an unset author is resolved from the live agent running in
 *  this very folder. Two agents sharing a folder is ambiguous — sign it
 *  generically rather than attribute the note to the wrong teammate. */
export async function authorFor(ctx: Ctx): Promise<string> {
  if (ctx.author?.trim()) return ctx.author.trim();
  if (ctx.resolvedAuthor) return ctx.resolvedAuthor;
  let name = UNKNOWN_AUTHOR;
  if (ctx.cwd) {
    try {
      const agents: { name: string; cwd?: string }[] = (await request(ctx, "GET", "/agents")).agents ?? [];
      const here = agents.filter((a) => a.cwd === ctx.cwd);
      if (here.length === 1) name = here[0]!.name;
    } catch { /* dashboard down — the tool's own call reports that properly */ }
  }
  ctx.resolvedAuthor = name;
  return name;
}

const getBoard = async (ctx: Ctx): Promise<Board> => (await request(ctx, "GET", "/board")).board as Board;

// ---- argument checking ----------------------------------------------------

type Args = Record<string, unknown>;

/** A required string argument. Missing or blank is the agent's mistake, so it
 *  fails here — before any write reaches the board. */
function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${key} is required`);
  return v;
}

function optionalStr(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

// ---- rendering ------------------------------------------------------------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The whole board as a compact digest: every column (with its instruction, the
 *  thing that tells an agent what that stage expects) and one line per card.
 *  Deliberately NOT the descriptions or comment bodies — those are what
 *  card_read is for, and inlining them here would make the common "what's on
 *  the board" call cost more the longer the board lives. */
export function formatBoard(board: Board): string {
  const out: string[] = [];
  for (const col of board.columns) {
    const instr = col.instruction.trim();
    out.push(`${col.name} (${col.id})${instr ? `  -- ${instr}` : ""}`);
    const cards = board.cards.filter((c) => c.columnId === col.id);
    if (cards.length === 0) out.push("  (empty)");
    for (const card of cards) {
      const bits = [`  [${card.id}] ${card.title}`];
      if (card.assignee) bits.push(`assigned: ${card.assignee.name}`);
      const n = card.comments?.length ?? 0;
      if (n) bits.push(plural(n, "comment"));
      out.push(bits.join("  |  "));
    }
  }
  return out.join("\n");
}

/** One card in full — the detail view an agent reads before acting on it. */
export function formatCard(board: Board, cardId: string): string {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`unknown card: ${cardId}`);
  const col = board.columns.find((c) => c.id === card.columnId);
  const out = [
    `[${card.id}] ${card.title}`,
    `column: ${card.columnId}${col ? ` (${col.name})` : ""}`,
    `assignee: ${card.assignee ? `${card.assignee.name} (${card.assignee.id})` : "none"}`,
  ];
  const instr = col?.instruction.trim();
  if (instr) out.push(`column instruction: ${instr}`);
  const description = (card.description ?? "").trim();
  out.push("", "description:", description || "(none)");
  const comments = card.comments ?? [];
  out.push("", `comments (${comments.length}):`);
  if (comments.length === 0) out.push("(none)");
  for (const c of comments) out.push(`- ${c.author} at ${new Date(c.at).toISOString()}: ${c.text}`);
  return out.join("\n");
}

type Agent = { sessionId: string; name: string; role: string; state: string; doing: string };

/** The live sessions, as the assignable list. `sessionId` first because that's
 *  the field card_assign needs. */
export function formatAgents(agents: Agent[]): string {
  if (agents.length === 0) return "No live agents right now — nothing can be assigned or sent a task.";
  return agents.map((a) => `${a.sessionId}  ${a.name}  (${a.role})  ${a.state}  ${a.doing}`).join("\n");
}

// ---- tools ----------------------------------------------------------------

export type Tool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run(args: Args, ctx: Ctx): Promise<string>;
};

const CARD_ID = { type: "string", description: "The card's id, e.g. card_867a2e3b (from board_read)." };

export const TOOLS: Tool[] = [
  {
    name: "board_read",
    description:
      "Read THE LINE, the team's kanban board: every column with its instruction (what that stage expects of work landing in it) and one line per card. Start here — card ids and column ids from this listing are what the other tools take.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return formatBoard(await getBoard(ctx));
    },
  },
  {
    name: "card_read",
    description: "Read one card in full: its description, assignee, its column's instruction, and every comment. Use after board_read when you need the detail.",
    inputSchema: { type: "object", properties: { cardId: CARD_ID }, required: ["cardId"] },
    async run(args, ctx) {
      return formatCard(await getBoard(ctx), str(args, "cardId"));
    },
  },
  {
    name: "card_create",
    description:
      "Create a card in a column. Write the description so an agent knowing nothing else can act on it: what to change, where, what done means, and any hard constraints stated bluntly.",
    inputSchema: {
      type: "object",
      properties: {
        columnId: { type: "string", description: "Column to create it in, e.g. backlog (from board_read)." },
        title: { type: "string", description: "Short one-line title." },
        description: { type: "string", description: "The full brief for whoever picks it up." },
      },
      required: ["columnId", "title"],
    },
    async run(args, ctx) {
      const body: Args = { columnId: str(args, "columnId"), title: str(args, "title") };
      const description = optionalStr(args, "description");
      if (description !== undefined) body.description = description;
      const out = await request(ctx, "POST", "/action/card-add", body);
      return `Created ${out.cardId} in "${body.columnId}".`;
    },
  },
  {
    name: "card_update",
    description: "Rename a card, rewrite its description, or both. Fields you leave out are untouched. This does not notify the assignee — comment if they need to know.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: CARD_ID,
        title: { type: "string", description: "New title. Omit to leave it alone." },
        description: { type: "string", description: "New description, replacing the old one. Omit to leave it alone." },
      },
      required: ["cardId"],
    },
    async run(args, ctx) {
      const body: Args = { cardId: str(args, "cardId") };
      const title = optionalStr(args, "title");
      const description = optionalStr(args, "description");
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (title === undefined && description === undefined) throw new Error("title or description is required");
      await request(ctx, "POST", "/action/card-update", body);
      return `Updated ${body.cardId}.`;
    },
  },
  {
    name: "card_move",
    description: "Move a card to another column. This is how progress is reported — move as you go, not in one write at the end. The card's assignee (or the scrum master) is notified.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: CARD_ID,
        toColumnId: { type: "string", description: "Destination column id (from board_read)." },
        author: { type: "string", description: "Who is moving it. Defaults to your own board codename." },
      },
      required: ["cardId", "toColumnId"],
    },
    async run(args, ctx) {
      const body = { cardId: str(args, "cardId"), toColumnId: str(args, "toColumnId"), author: optionalStr(args, "author") ?? (await authorFor(ctx)) };
      await request(ctx, "POST", "/action/card-move", body);
      return `Moved ${body.cardId} to "${body.toColumnId}".`;
    },
  },
  {
    name: "card_comment",
    description: "Post a comment on a card. Keep it plain and short — a quick note to a busy teammate. The other side of the card (assignee or scrum master) is woken with it.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: CARD_ID,
        text: { type: "string", description: "The comment body." },
        author: { type: "string", description: "Who is writing. Defaults to your own board codename." },
      },
      required: ["cardId", "text"],
    },
    async run(args, ctx) {
      const body = { cardId: str(args, "cardId"), author: optionalStr(args, "author") ?? (await authorFor(ctx)), text: str(args, "text") };
      await request(ctx, "POST", "/action/card-comment", body);
      return `Commented on ${body.cardId}.`;
    },
  },
  {
    name: "card_assign",
    description: "Assign a card to a LIVE agent session (see agents_list), or pass sessionId: null to unassign. Assigning only binds the card; use card_send_task to actually hand the work over.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: CARD_ID,
        sessionId: { type: ["string", "null"], description: "A live session id from agents_list, or null to unassign." },
      },
      required: ["cardId", "sessionId"],
    },
    async run(args, ctx) {
      const cardId = str(args, "cardId");
      const sessionId = args.sessionId;
      if (sessionId !== null && typeof sessionId !== "string") throw new Error("sessionId is required (a live session id, or null to unassign)");
      await request(ctx, "POST", "/action/card-assign", { cardId, sessionId });
      return sessionId === null ? `Unassigned ${cardId}.` : `Assigned ${cardId} to ${sessionId}.`;
    },
  },
  {
    name: "card_send_task",
    description:
      "Hand the card's work to its assigned agent: the dashboard composes the card's title, description and column instruction into a task with the board protocol, clears that session's context, and types it into its terminal. Assign first.",
    inputSchema: {
      type: "object",
      properties: { cardId: CARD_ID, author: { type: "string", description: "Who is sending. Defaults to your own board codename." } },
      required: ["cardId"],
    },
    async run(args, ctx) {
      const body = { cardId: str(args, "cardId"), author: optionalStr(args, "author") ?? (await authorFor(ctx)) };
      await request(ctx, "POST", "/action/send-task", body);
      return `Sent ${body.cardId} to its assignee.`;
    },
  },
  {
    name: "agents_list",
    description: "List the live agent sessions — session id, board name, role, and what each is doing. These session ids are the only things a card can be assigned to.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return formatAgents((await request(ctx, "GET", "/agents")).agents ?? []);
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---- JSON-RPC dispatch ----------------------------------------------------

const ok = (id: unknown, result: object) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (body: string, isError?: true) => ({ content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) });

/** Handle one JSON-RPC message. Returns the reply, or null for a notification
 *  (no id) — MCP forbids answering those. A tool that fails answers with an
 *  isError result rather than a protocol error, so the model reads the reason
 *  and can correct itself instead of the call looking broken. */
export async function handleMessage(msg: any, ctx: Ctx): Promise<object | null> {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: any };
  if (id === undefined || id === null) return null; // notification
  if (typeof method !== "string") return err(id, -32600, "invalid request");

  if (method === "initialize") {
    const asked = params?.protocolVersion;
    const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    return ok(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const tool = typeof name === "string" ? BY_NAME.get(name) : undefined;
    if (!tool) return ok(id, text(`unknown tool: ${String(name)}. Available: ${TOOLS.map((t) => t.name).join(", ")}`, true));
    try {
      return ok(id, text(await tool.run((params?.arguments ?? {}) as Args, ctx)));
    } catch (e) {
      return ok(id, text(e instanceof Error ? e.message : String(e), true));
    }
  }
  return err(id, -32601, `method not found: ${method}`);
}
