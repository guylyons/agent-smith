// The board's MCP surface: tool definitions plus the JSON-RPC dispatch behind
// them. Everything here is pure logic over an injected `Api`, so the whole
// protocol is unit-tested without a subprocess, a socket, or a dashboard.
// `src/mcp.ts` is the thin I/O shell that wires this to stdio and fetch.
//
// Writes go through the dashboard's HTTP actions rather than the board file,
// for the same reason the agent protocol footer does: the server applies each
// card-scoped mutation against the latest board, so two writers can never
// clobber each other, and the open UI updates live.
import { cardView, type Board } from "./board";
import { MOOD_KINDS, formatMood, moodBounds, type Mood } from "./mood";
import { FACT_KINDS, formatResults } from "./memory";

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
  /** This session's folder, used to look our own session up. */
  cwd?: string;
  /** The card this session was spawned for (AGENT_CARD), if any: on that card
   *  we are its assignee and sign as such. */
  card?: string;
  /** This session's crew id (AGENT_CREW), if the dashboard minted one: whose
   *  notes crew_note keeps. */
  crew?: string;
  /** Memo for signatureFor. Resolving costs a request, and the answer can't
   *  change for the life of the process. */
  resolvedSignature?: Signature;
};

/** How a write is signed. The server resolves `as: "assignee"` to the card's
 *  assignee and `sessionId` to that session's current desk name — both by
 *  identity, so a rename or a persona can never mis-sign a comment. A bare
 *  `author` is the last resort. */
export type Signature = ({ as: "assignee" } | { sessionId: string } | { author: string }) & { crew?: string };

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

/** Who to sign a move or comment on `cardId` as. An explicit name (the
 *  AGENT_WORKSHOP_AUTHOR env, or an `author` argument) wins. On the card this
 *  session was spawned for, it is the assignee. Otherwise the live agent
 *  running in this very folder is us — signed by session id, so the server
 *  uses its current desk name. Two agents sharing a folder is ambiguous:
 *  sign generically rather than attribute the note to the wrong teammate. */
export async function signatureFor(ctx: Ctx, cardId: string, author?: string): Promise<Signature> {
  const sig = await bareSignatureFor(ctx, cardId, author);
  // Our crew id rides along on every write, whichever convention signs it, so
  // a write from us after we were taken off the card is refused (409) instead
  // of landing under our name or the new assignee's.
  return ctx.crew ? { ...sig, crew: ctx.crew } : sig;
}

async function bareSignatureFor(ctx: Ctx, cardId: string, author?: string): Promise<Signature> {
  const explicit = (author ?? ctx.author)?.trim();
  if (explicit) return { author: explicit };
  if (ctx.card && ctx.card === cardId) return { as: "assignee" };
  if (ctx.resolvedSignature) return ctx.resolvedSignature;
  let sig: Signature = { author: UNKNOWN_AUTHOR };
  if (ctx.cwd) {
    try {
      const agents: { sessionId: string; cwd?: string }[] = (await request(ctx, "GET", "/agents")).agents ?? [];
      const here = agents.filter((a) => a.cwd === ctx.cwd);
      if (here.length === 1) sig = { sessionId: here[0]!.sessionId };
    } catch { /* dashboard down — the tool's own call reports that properly */ }
  }
  ctx.resolvedSignature = sig;
  return sig;
}

/** Kept for callers that only want a display name (tests, the send-task
 *  author line): the name a signature would resolve to when it is a bare one. */
export async function authorFor(ctx: Ctx): Promise<string> {
  const sig = await signatureFor(ctx, "");
  return "author" in sig ? sig.author : UNKNOWN_AUTHOR;
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

/** An optional list-of-strings argument. Absent stays absent (the field is left
 *  alone); an empty list is a real value (it clears the field). A non-list, or a
 *  list with a non-string in it, is the agent's mistake and fails here. */
function optionalStrList(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${key} must be a list of strings`);
  return v as string[];
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
      const bits = [`  [${card.id}] ${numLabel(card)}${card.title}`];
      if (card.repo) bits.push(`repo: ${card.repo}`);
      if (card.assignee) bits.push(`assigned: ${card.assignee.name}`);
      const n = card.comments?.length ?? 0;
      if (n) bits.push(plural(n, "comment"));
      out.push(bits.join("  |  "));
    }
  }
  return out.join("\n");
}

/** "#42 " for a numbered card, so an agent can match the number a person
 *  quotes to the id the tools take; "" for one not numbered yet. */
function numLabel(card: { num?: number }): string {
  return card.num ? `#${card.num} ` : "";
}

/** One card in full — the detail view an agent reads before acting on it. */
export function formatCard(board: Board, cardId: string): string {
  const view = cardView(board, cardId);
  if (!view) throw new Error(`unknown card: ${cardId}`);
  const { card, columns } = view;
  const col = columns.find((c) => c.id === card.columnId);
  const out = [
    `[${card.id}] ${numLabel(card)}${card.title}`,
    `column: ${card.columnId}${col ? ` (${col.name})` : ""}`,
    `assignee: ${card.assignee ? `${card.assignee.name} (${card.assignee.id})` : "none"}`,
  ];
  const instr = col?.instruction.trim();
  if (instr) out.push(`column instruction: ${instr}`);
  // The card's file claim (see overlappingClaims in lib/board): what it is
  // expected to change, and therefore what it blocks others from being staffed on.
  out.push(`touches: ${card.touches?.length ? card.touches.join(", ") : "(none)"}`);
  // Which project the card is for — one board holds several repos.
  out.push(`repo: ${card.repo ? `${card.repo}${card.repoPath ? ` (${card.repoPath})` : ""}` : "(none)"}`);
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
    description: "Rename a card, rewrite its description, set the files it touches, or label its repo. Fields you leave out are untouched. This does not notify the assignee — comment if they need to know.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: CARD_ID,
        title: { type: "string", description: "New title. Omit to leave it alone." },
        description: { type: "string", description: "New description, replacing the old one. Omit to leave it alone." },
        touches: {
          type: "array",
          items: { type: "string" },
          description:
            "The files this card is expected to change: paths or globs from the repo root (e.g. src/ui/CardModal.tsx, src/lib/**). This is the card's FILE CLAIM — while it is staffed and unmerged, no other card touching the same files can be staffed. Replaces the whole list; pass [] to clear it.",
        },
        repo: { type: "string", description: "Which repo/project the card is for — a short name like the repo folder (e.g. agent-smith). Pass \"\" to clear it. Omit to leave it alone." },
      },
      required: ["cardId"],
    },
    async run(args, ctx) {
      const body: Args = { cardId: str(args, "cardId") };
      const title = optionalStr(args, "title");
      const description = optionalStr(args, "description");
      const touches = optionalStrList(args, "touches");
      const repo = optionalStr(args, "repo");
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (touches !== undefined) body.touches = touches;
      if (repo !== undefined) body.repo = repo;
      if (title === undefined && description === undefined && touches === undefined && repo === undefined) {
        throw new Error("title, description, touches or repo is required");
      }
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
        author: { type: "string", description: "Who is moving it. Leave it out: the board signs it as you." },
      },
      required: ["cardId", "toColumnId"],
    },
    async run(args, ctx) {
      const cardId = str(args, "cardId");
      const body = { cardId, toColumnId: str(args, "toColumnId"), ...(await signatureFor(ctx, cardId, optionalStr(args, "author"))) };
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
        author: { type: "string", description: "Who is writing. Leave it out: the board signs it as you." },
        pin: { type: "boolean", description: "Pin this comment to the top of the card as its handoff note, replacing any earlier pin. Send it on your final comment before moving the card to review." },
        ask: { type: "boolean", description: "Flag the card WAITING ON YOU with this comment as the question. Only for a decision the human alone can make, not progress or a permission prompt. Clears when the human replies on the card." },
      },
      required: ["cardId", "text"],
    },
    async run(args, ctx) {
      const cardId = str(args, "cardId");
      const pin = args.pin === true;
      const ask = args.ask === true;
      const body = { cardId, text: str(args, "text"), ...(pin ? { pin } : {}), ...(ask ? { ask } : {}), ...(await signatureFor(ctx, cardId, optionalStr(args, "author"))) };
      await request(ctx, "POST", "/action/card-comment", body);
      const also = [pin && "pinned it", ask && "flagged it waiting on the user"].filter(Boolean).join(" and ");
      return also ? `Commented on ${body.cardId} and ${also}.` : `Commented on ${body.cardId}.`;
    },
  },
  {
    name: "card_assign",
    description: "Assign a card to a LIVE agent session (see agents_list), or pass sessionId: null to unassign. Assigning only binds the card; use card_send_task to actually hand the work over. Refused when the card's `touches` overlap those of another active, unmerged card — staffing both would put two agents on the same files.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: CARD_ID,
        sessionId: { type: ["string", "null"], description: "A live session id from agents_list, or null to unassign." },
        force: { type: "boolean", description: "Assign anyway when another active card already claims some of the same files. Only for a human who has decided the collision risk is acceptable." },
      },
      required: ["cardId", "sessionId"],
    },
    async run(args, ctx) {
      const cardId = str(args, "cardId");
      const sessionId = args.sessionId;
      if (sessionId !== null && typeof sessionId !== "string") throw new Error("sessionId is required (a live session id, or null to unassign)");
      const body: Args = { cardId, sessionId };
      if (args.force === true) body.force = true;
      await request(ctx, "POST", "/action/card-assign", body);
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
    name: "crew_note",
    description:
      "Keep your own notes: what your future self should know after a /clear (decisions, gotchas, where things live). They are handed back to you at the start of every session. Short lines; the whole file is capped, and a write past the cap is refused so you rewrite it shorter with replace: true.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note to add (one line is best). With replace: true, the whole new contents." },
        replace: { type: "boolean", description: "Replace all your notes with `text` instead of adding a line." },
      },
      required: ["text"],
    },
    async run(args, ctx) {
      const text = String(args.text ?? "");
      const replace = args.replace === true;
      // Who we are: the crew id from the launch env, else the card we were
      // spawned for, else the live session in this folder. A bare author name
      // can't own notes, so it is not a fallback here.
      let who: Record<string, unknown>;
      if (ctx.crew) who = { crew: ctx.crew };
      else if (ctx.card) who = { cardId: ctx.card, as: "assignee" };
      else {
        const sig = await signatureFor(ctx, "");
        if (!("sessionId" in sig)) throw new Error("can't tell which crew member you are (no AGENT_CREW, no card, and this folder is ambiguous)");
        who = sig;
      }
      const r = await request(ctx, "POST", "/action/crew-note", { ...who, text, replace });
      const notes = String(r?.notes ?? "").trim();
      return notes ? `Your notes now read:\n${notes}` : "Your notes are empty.";
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


// ---- the MOOD board ---------------------------------------------------------
// The team's big picture (see src/lib/mood.ts): where THE LINE tracks each
// task, the mood board is where an agent says what it all adds up to.

const NOTE_ID = { type: "string", description: "The note's id, e.g. note_1a2b3c4d (from mood_read)." };
const KIND = {
  type: "string",
  enum: [...MOOD_KINDS],
  description: "What the note is saying: focus (what we're on now), idea, risk, question (needs an answer), done (just landed), note, or heading (a big bare label for an area of the board).",
};

const getMood = async (ctx: Ctx): Promise<Mood> => (await request(ctx, "GET", "/mood")).mood as Mood;

/** The display name to sign a note with: an explicit author, else this
 *  folder's live agent by its desk name, else the generic one. */
async function moodAuthor(ctx: Ctx, author?: string): Promise<string> {
  const sig = await signatureFor(ctx, "", author);
  if ("author" in sig) return sig.author;
  if ("sessionId" in sig) {
    try {
      const agents: { sessionId: string; name: string }[] = (await request(ctx, "GET", "/agents")).agents ?? [];
      return agents.find((a) => a.sessionId === sig.sessionId)?.name ?? UNKNOWN_AUTHOR;
    } catch { /* fall through */ }
  }
  return UNKNOWN_AUTHOR;
}

function optionalNum(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
}

/** Where a note goes when the agent doesn't say: under everything already on
 *  the board, so it never lands on top of someone else's note. */
export function nextNoteSpot(mood: Mood): { x: number; y: number } {
  const b = moodBounds(mood);
  return b ? { x: b.x, y: b.y + b.h + 40 } : { x: 0, y: 0 };
}

TOOLS.push(
  {
    name: "mood_read",
    description:
      "Read the MOOD board: the team's big-picture canvas of notes (focus, ideas, risks, open questions, what just landed) and the links between them. Read it before adding to it, so you update a note rather than repeat it.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return formatMood(await getMood(ctx));
    },
  },
  {
    name: "mood_note_add",
    description:
      "Put a note on the MOOD board to tell the human, at a glance, what is going on: what you're focused on, a risk you see, a question that needs an answer, what just landed. Keep the title short; put detail in body. Omit x/y to place it below everything else.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short headline, a few words." },
        body: { type: "string", description: "Optional detail, a line or two." },
        kind: KIND,
        cardId: { type: "string", description: "Optional THE LINE card this note is about, e.g. card_867a2e3b." },
        x: { type: "number", description: "Canvas x of the note's left edge. Notes are ~220 wide." },
        y: { type: "number", description: "Canvas y of the note's top edge. Notes are ~120 tall." },
      },
      required: ["title"],
    },
    async run(args, ctx) {
      const title = str(args, "title");
      let x = optionalNum(args, "x");
      let y = optionalNum(args, "y");
      if (x === undefined || y === undefined) {
        const spot = nextNoteSpot(await getMood(ctx));
        x ??= spot.x;
        y ??= spot.y;
      }
      const body: Args = { title, x, y, author: await moodAuthor(ctx) };
      for (const k of ["body", "kind", "cardId"]) {
        const v = optionalStr(args, k);
        if (v !== undefined) body[k] = v;
      }
      const out = await request(ctx, "POST", "/action/mood-note-add", body);
      return `Added ${out.noteId} at ${x},${y}.`;
    },
  },
  {
    name: "mood_note_update",
    description: "Change a MOOD board note: retitle it, rewrite its body, change its kind (e.g. question -> done), move it, or point it at a card. Fields you leave out are untouched.",
    inputSchema: {
      type: "object",
      properties: {
        noteId: NOTE_ID,
        title: { type: "string" },
        body: { type: "string", description: "Replaces the body; \"\" clears it." },
        kind: KIND,
        cardId: { type: "string", description: "THE LINE card it is about; \"\" unlinks it." },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["noteId"],
    },
    async run(args, ctx) {
      const body: Args = { noteId: str(args, "noteId") };
      for (const k of ["title", "body", "kind", "cardId"]) {
        const v = optionalStr(args, k);
        if (v !== undefined) body[k] = v;
      }
      for (const k of ["x", "y"]) {
        const v = optionalNum(args, k);
        if (v !== undefined) body[k] = v;
      }
      await request(ctx, "POST", "/action/mood-note-update", body);
      return `Updated ${body.noteId}.`;
    },
  },
  {
    name: "mood_note_delete",
    description: "Take a note off the MOOD board, along with its links. Prefer turning a finished note into kind \"done\" over deleting it, unless it is wrong or stale.",
    inputSchema: { type: "object", properties: { noteId: NOTE_ID }, required: ["noteId"] },
    async run(args, ctx) {
      const noteId = str(args, "noteId");
      await request(ctx, "POST", "/action/mood-note-delete", { noteId });
      return `Deleted ${noteId}.`;
    },
  },
  {
    name: "mood_link",
    description: "Draw an arrow between two MOOD board notes, with an optional short label (e.g. \"blocks\", \"leads to\", \"needs\"). One link per pair of notes.",
    inputSchema: {
      type: "object",
      properties: {
        from: { ...NOTE_ID, description: "The note the arrow starts at." },
        to: { ...NOTE_ID, description: "The note the arrow points to." },
        label: { type: "string", description: "Optional, a word or two." },
      },
      required: ["from", "to"],
    },
    async run(args, ctx) {
      const body: Args = { from: str(args, "from"), to: str(args, "to") };
      const label = optionalStr(args, "label");
      if (label !== undefined) body.label = label;
      const out = await request(ctx, "POST", "/action/mood-link-add", body);
      return `Linked ${body.from} -> ${body.to} (${out.linkId}).`;
    },
  },
  {
    name: "mood_unlink",
    description: "Remove an arrow between two MOOD board notes, by its link id (from mood_read).",
    inputSchema: { type: "object", properties: { linkId: { type: "string", description: "e.g. link_1a2b3c4d" } }, required: ["linkId"] },
    async run(args, ctx) {
      const linkId = str(args, "linkId");
      await request(ctx, "POST", "/action/mood-link-delete", { linkId });
      return `Removed ${linkId}.`;
    },
  },
);

// ---- the team memory -----------------------------------------------------------
// What was done before and why (see src/lib/memory.ts): recorded facts plus
// every card on the board and in the archive, searchable by keyword and filter.

TOOLS.push(
  {
    name: "memory_search",
    description:
      "Search the team memory: past cards (board and archive) plus the decisions, gotchas, notes and summaries agents recorded. Words must all match; filters narrow: kind:decision,gotcha  repo:<name>  file:<path or folder>  person:<NAME>  tag:<t>  card:<card id>  near:<node id> (linked nodes)  since:14d. An empty query lists the newest. Pass id instead to see one node and everything linked to it. Search before planning work, so you build on what is known.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words and filters, e.g. \"merge race repo:agent-smith kind:decision\"." },
        id: { type: "string", description: "A node id (mem_1a2b3c4d or card:card_1a2b) to show with its neighbours, instead of a search." },
        limit: { type: "number", description: "Most results to return (default 20)." },
      },
    },
    async run(args, ctx) {
      const id = optionalStr(args, "id")?.trim();
      if (id) {
        const r = await request(ctx, "GET", `/memory?${new URLSearchParams({ id })}`);
        return formatResults([r.node, ...(r.neighbours ?? [])]);
      }
      const q = new URLSearchParams({ q: optionalStr(args, "query") ?? "" });
      const limit = optionalNum(args, "limit");
      if (limit !== undefined) q.set("limit", String(limit));
      return formatResults((await request(ctx, "GET", `/memory?${q}`)).results ?? []);
    },
  },
  {
    name: "memory_add",
    description:
      "Record something the team should remember: a decision (and why), a gotcha that bit you, a note, or a summary rolling up several cards. Link it so it can be found: repo:<name>, file:<path>, person:<NAME>, a card id, or another memory's id. The same kind and title again updates that memory instead of adding a copy. Old memories are compacted to one line automatically, so lead with the point.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...FACT_KINDS], description: "decision, gotcha, note, or summary." },
        title: { type: "string", description: "The point, in one short line." },
        body: { type: "string", description: "Optional detail. First sentence first: it is what survives compaction." },
        links: { type: "array", items: { type: "string" }, description: "What it is about: repo:<name>, file:<path>, person:<NAME>, card_<id>, mem_<id>." },
        tags: { type: "array", items: { type: "string" }, description: "Optional free labels." },
      },
      required: ["kind", "title"],
    },
    async run(args, ctx) {
      const body = {
        kind: str(args, "kind"),
        title: str(args, "title"),
        body: optionalStr(args, "body") ?? "",
        links: optionalStrList(args, "links") ?? [],
        tags: optionalStrList(args, "tags") ?? [],
        author: await moodAuthor(ctx),
      };
      const r = await request(ctx, "POST", "/action/memory-add", body);
      return `Remembered:\n${formatResults([r.node])}`;
    },
  },
  {
    name: "memory_forget",
    description: "Delete a recorded memory that is wrong or no longer true, by its mem_ id (from memory_search). Cards cannot be forgotten here; they come from the board.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The memory's id, e.g. mem_1a2b3c4d." } }, required: ["id"] },
    async run(args, ctx) {
      const id = str(args, "id");
      await request(ctx, "POST", "/action/memory-forget", { id });
      return `Forgot ${id}.`;
    },
  },
);

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
