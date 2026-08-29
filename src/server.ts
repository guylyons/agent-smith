import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { parseStatus, type AgentStatus } from "./schema";
import { buildSnapshot, type Snapshot } from "./lib/snapshot";
import { ensureStatusDir, statusDir } from "./lib/paths";
import { scanLiveSessions, readConversation, readSubagents } from "./scan";
import { matchChat } from "./lib/chatsearch";
import type { ChatMessage } from "./lib/conversation";
import { readOverrides, applyOverrides, setNameOverride, setSpriteOverride } from "./lib/overrides";
import { loadPersonas, applyPersonas } from "./lib/personas";
import { readBoard, writeBoard, sanitizeBoard, boardFile, addCard, moveCard, addComment, assignCard, renameCard, setCardDescription, cardTaskPrompt, addColumn, renameColumn, setInstruction, deleteColumn, reorderColumn, restoreColumn, deleteCard, restoreCard, deleteComment, sanitizeCard, sanitizeColumn, type Board, type Card, type Column } from "./lib/board";
import { ALLOWED_MODELS, ALLOWED_PERMISSION_MODES, focusSession, interruptSession, killAgent, sendPrompt, sendFreshPrompt, spawnAgent } from "./ghostty";
import { readRepo } from "./repo";
import { saveUpload, resolveUploadPath } from "./lib/uploads";
import { initialIdle, onConnect, onDisconnect, shouldShutDown, type IdleState } from "./lib/idle";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// sessionId comes from the client; keep it to a single, safe path/key segment.
function validSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && /^[A-Za-z0-9-]+$/.test(sessionId);
}

function loadStatus(dir: string, sessionId: string): AgentStatus | null {
  if (!validSessionId(sessionId)) return null;
  try { return parseStatus(JSON.parse(readFileSync(join(dir, `${sessionId}.json`), "utf8"))); }
  catch { return null; }
}

/** Resolve a session id to an `{ id, name }` assignee, applying the same
 *  persona/override name resolution the live view uses. Prefers the fresh
 *  snapshot, but falls back to the session's own on-disk status file when it
 *  isn't surfaced as live yet — so a NEW agent's self-assign at SessionStart
 *  can't lose the race with the snapshot and silently leave the card unassigned.
 *  Returns null only when no status file exists for the id at all. */
export function resolveAssignee(dir: string, sessionId: string): { id: string; name: string } | null {
  const live = readSnapshot(dir, Date.now()).agents.find((a) => a.sessionId === sessionId);
  if (live) return { id: live.sessionId, name: live.name };
  const raw = loadStatus(dir, sessionId);
  if (!raw) return null;
  const [resolved] = applyOverrides(applyPersonas([raw], loadPersonas()), readOverrides(dir));
  return resolved ? { id: resolved.sessionId, name: resolved.name } : null;
}

export function readSnapshot(dir: string, now: number): Snapshot {
  const agents: AgentStatus[] = [];
  let names: string[] = [];
  // status files are <sessionId>.json; skip dotfiles like .overrides.json / .line.json
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")); } catch { /* no dir yet */ }
  for (const f of names) {
    try {
      const s = parseStatus(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (s) agents.push(s);
    } catch { /* half-written; skip */ }
  }
  // personas resolve INSIDE applyOverrides so a name you typed yourself wins:
  // user override > persona > inferRole > hashed codename
  return buildSnapshot(applyOverrides(applyPersonas(agents, loadPersonas()), readOverrides(dir)), now, {
    board: readBoard(dir),
  });
}

export type ChatHitResult = { sessionId: string; name: string; role: string; snippet: string; hitRole: ChatMessage["role"] };

/**
 * Quick-find's chat half: search the transcripts of the sessions currently on
 * the board for `query`, returning one snippet per session that mentions it.
 * Scoped to live sessions so every hit is one the palette can actually open in
 * the drawer. `readConv` is injectable so it's unit-tested without transcripts.
 */
export async function searchChats(
  dir: string,
  query: string,
  now: number,
  readConv: (sessionId: string) => Promise<{ messages: ChatMessage[] }> = readConversation,
): Promise<ChatHitResult[]> {
  if (!query.trim()) return [];
  const { agents } = readSnapshot(dir, now);
  const hits = await Promise.all(
    agents.map(async (a) => {
      const { messages } = await readConv(a.sessionId);
      const hit = matchChat(messages, query);
      return hit ? { sessionId: a.sessionId, name: a.name, role: a.role, snippet: hit.snippet, hitRole: hit.role } : null;
    }),
  );
  return hits.filter((h): h is ChatHitResult => h !== null);
}

export function makeServer(
  port: number,
  opts: {
    scan?: boolean;
    scanIntervalMs?: number;
    /** How a composed prompt reaches a session's terminal. Injectable so tests
     *  capture deliveries instead of driving AppleScript. */
    deliver?: (target: AgentStatus, text: string) => Promise<{ ok: boolean; error?: string }>;
    /** How a NEW card task reaches a session: clears the agent's context first
     *  (see sendFreshPrompt) so each ticket starts clean. Injectable like
     *  deliver. */
    deliverFresh?: (target: AgentStatus, text: string) => Promise<{ ok: boolean; error?: string }>;
    /** Opt-in, for the stand-alone app window (`bun run app`): called once the
     *  last dashboard window has been shut for `idleGraceMs`, or never opened
     *  within `idleStartupGraceMs`. Left unset, the server serves forever with
     *  no window attached — which is what `bun run dev` wants. */
    onWindowsClosed?: () => void;
    idleGraceMs?: number;
    idleStartupGraceMs?: number;
    idleCheckMs?: number;
  } = {},
) {
  const {
    scan = false, scanIntervalMs = 20_000, deliver = sendPrompt, deliverFresh = sendFreshPrompt,
    onWindowsClosed, idleGraceMs = 5_000, idleStartupGraceMs = 30_000, idleCheckMs = 1_000,
  } = opts;
  const dir = ensureStatusDir();

  // Wake the sessions that care about a card event, best-effort and without
  // blocking the response. Recipients: the card's live assignee plus every live
  // scrum-master session — minus whoever authored the event (matched by display
  // name), so an agent is never woken by its own update. ASCII-only text: the
  // pty path this rides is known to mangle anything else.
  function notifyCardEvent(board: Board, cardId: string, author: string, text: string) {
    const card = board.cards.find((k) => k.id === cardId);
    if (!card) return;
    const { agents } = readSnapshot(dir, Date.now());
    const targets = agents.filter(
      (a) =>
        a.name !== author &&
        // NEVER deliver into a session that's waiting on a dialog (permission
        // prompt, plan approval, question): typed input there presses keys on
        // the dialog — a live run showed notifications auto-APPROVING pending
        // permission prompts, which cascaded into runaway agent spawns. A
        // missed notification is fine; the comment is on the board.
        a.state !== "waiting" &&
        (a.persona === "scrum-master" || (card.assignee && a.sessionId === card.assignee.id)),
    );
    for (const t of targets) void deliver(t, text).catch(() => { /* best-effort */ });
  }
  const clients = new Set<(s: Snapshot) => void>();

  // One /events stream per open dashboard window, so the client count doubles
  // as "is anyone looking at this?". Both paths that leave the Set go through
  // dropClient, and it only counts a client out if it was actually in — a
  // window that leaves twice (push() drops it, then cancel() fires) must not
  // subtract twice.
  let idle: IdleState = initialIdle(Date.now());
  const addClient = (send: (s: Snapshot) => void) => {
    clients.add(send);
    idle = onConnect(idle, Date.now());
  };
  const dropClient = (send: (s: Snapshot) => void) => {
    if (clients.delete(send)) idle = onDisconnect(idle, Date.now());
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    const snap = readSnapshot(dir, Date.now());
    for (const send of clients) {
      try {
        send(snap);
      } catch {
        // Client's controller is closed (cancel() hasn't fired yet) —
        // drop it so it isn't retried on the next push.
        dropClient(send);
      }
    }
  };
  const watcher = watch(dir, () => { if (timer) clearTimeout(timer); timer = setTimeout(push, 150); });

  // Surface currently-open Claude Code sessions by scanning their transcripts,
  // on startup and on an interval. Hooks handle real-time deltas in between.
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  if (scan) {
    let scanning = false;
    const runScan = async () => {
      if (scanning) return; // don't overlap passes
      scanning = true;
      try { await scanLiveSessions(Date.now()); } catch { /* keep serving */ }
      finally { scanning = false; }
      push();
    };
    void runScan();
    scanTimer = setInterval(() => void runScan(), scanIntervalMs);
  }

  // Watch for the last window closing. Only armed when a caller asked for it,
  // so a plain `bun run dev` is untouched.
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  if (onWindowsClosed) {
    idleTimer = setInterval(() => {
      if (!shouldShutDown(idle, Date.now(), { graceMs: idleGraceMs, startupGraceMs: idleStartupGraceMs })) return;
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
      onWindowsClosed();
    }, idleCheckMs);
  }

  const server = Bun.serve({
    port,
    // Bind to loopback only. Bun defaults to 0.0.0.0 when hostname is omitted,
    // which would expose every mutating action (spawn with bypassPermissions =
    // arbitrary code execution, kill, prompt, upload) to anyone on the LAN — the
    // sec-fetch-site CSRF check does not stop a non-browser client that sends no
    // such header. This is a single-user local dashboard; keep it on localhost.
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        let send!: (s: Snapshot) => void;
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            send = (s) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`));
            addClient(send);
            send(readSnapshot(dir, Date.now())); // initial
          },
          cancel() { dropClient(send); },
        });
        return new Response(stream, { headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        }});
      }
      // a session's full conversation (+ any pending question)
      if (url.pathname === "/conversation") {
        const sid = url.searchParams.get("sessionId") ?? "";
        if (!validSessionId(sid)) return json({ messages: [], question: null, blocked: null }, 400);
        return json(await readConversation(sid));
      }

      // quick-find's chat search: snippets from live sessions' transcripts that
      // mention the query. Cards/agents are searched client-side from the
      // snapshot; only chat content needs the server (it reads transcripts).
      if (url.pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        return json({ chats: await searchChats(dir, q, Date.now()) });
      }

      // a session's live subagents
      if (url.pathname === "/subagents") {
        const sid = url.searchParams.get("sessionId") ?? "";
        if (!validSessionId(sid)) return json({ subagents: [] }, 400);
        return json({ subagents: await readSubagents(sid, Date.now()) });
      }

      // the current board + where it lives — the read half of the agent card
      // API. Always a fresh read, so an agent that just wrote sees its write.
      if (url.pathname === "/board") {
        return json({ board: readBoard(dir), boardPath: boardFile(dir) });
      }

      // the live sessions, with names/roles resolved the way the board shows
      // them — how an orchestrating agent discovers who it can assign to.
      if (url.pathname === "/agents") {
        const { agents } = readSnapshot(dir, Date.now());
        return json({
          agents: agents.map(({ sessionId, name, role, state, doing, persona, cwd, branch }) =>
            ({ sessionId, name, role, state, doing, persona, cwd, branch })),
        });
      }

      // the persona picker's options
      if (url.pathname === "/personas") {
        // id/name/role/skills only — the prompt body is never sent to the browser
        return json(loadPersonas().map(({ id, name, role, skills }) => ({ id, name, role, skills })));
      }

      // a session's git context (branch, commits, working-tree status)
      if (url.pathname === "/repo") {
        const sid = url.searchParams.get("sessionId") ?? "";
        if (!validSessionId(sid)) return json({ error: "bad sessionId" }, 400);
        const status = loadStatus(dir, sid);
        if (!status) return json({ error: "unknown session" }, 404);
        return json(await readRepo(status.cwd));
      }

      // commands: act on a real session
      if (req.method === "POST" && url.pathname.startsWith("/action/")) {
        // Block cross-site POSTs (localhost-CSRF from another local tab). Our own
        // page sends same-origin; direct clients (curl) send no such header.
        const site = req.headers.get("sec-fetch-site");
        if (site && site !== "same-origin" && site !== "none") {
          return json({ ok: false, error: "cross-site blocked" }, 403);
        }
        const action = url.pathname.slice("/action/".length);
        let body: { sessionId?: string | null; name?: string; text?: string; cwd?: string; palette?: number; gear?: string; body?: string; model?: string; permissionMode?: string; worktree?: string; persona?: string; board?: unknown; type?: string; dataBase64?: string; cardId?: string; columnId?: string; toColumnId?: string; title?: string; description?: string; author?: string; instruction?: string; toIndex?: number; index?: number; column?: unknown; card?: unknown; cards?: unknown; commentId?: string };
        try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
        // spawn creates a brand-new session — it has a folder + task, not a sessionId
        if (action === "spawn") {
          const cwd = typeof body.cwd === "string" ? body.cwd : "";
          const task = typeof body.text === "string" ? body.text : "";
          if (!cwd || !task.trim()) return json({ ok: false, error: "folder and task are required" }, 400);
          try { if (!statSync(cwd).isDirectory()) throw 0; } catch { return json({ ok: false, error: `folder not found: ${cwd}` }, 400); }
          const model = typeof body.model === "string" && ALLOWED_MODELS.has(body.model) ? body.model : undefined;
          const permissionMode = typeof body.permissionMode === "string" && ALLOWED_PERMISSION_MODES.has(body.permissionMode) ? body.permissionMode : undefined;
          // A blank/whitespace field means "no worktree" (launch in the folder). The
          // name is sanitized to a slug inside createWorktree, so pass it as typed.
          const worktree = typeof body.worktree === "string" && body.worktree.trim() ? body.worktree.trim() : undefined;
          const persona = typeof body.persona === "string" && body.persona.trim() ? body.persona.trim() : undefined;
          // The card this agent is being spawned for, if any: rides into the
          // session env so its SessionStart hook self-assigns the card once the
          // real session id exists.
          const cardId = typeof body.cardId === "string" && body.cardId.trim() ? body.cardId.trim() : undefined;
          // Loop-breaker: an agent (curl sends no sec-fetch-site) may spawn
          // workers but never another orchestrator. A live run showed confused
          // scrum-masters spawning scrum-masters exponentially; only a human in
          // the browser may start one.
          if (persona === "scrum-master" && !req.headers.get("sec-fetch-site")) {
            return json({ ok: false, error: "agents may not spawn a scrum-master — only a human can (use the + NEW AGENT dialog)" }, 403);
          }
          return json(await spawnAgent(cwd, task, { model, permissionMode, worktree, persona, serverUrl: url.origin, cardId }));
        }
        // board: a whole-board write. Kept for external/scripted callers, but
        // NOTHING in the UI uses it any more: it overwrites the file wholesale,
        // so a writer holding a slightly stale board silently erases whatever
        // landed since it read. Every browser edit now goes through the scoped
        // column-*/card-* ops below instead. Not tied to a sessionId.
        if (action === "board") {
          writeBoard(dir, sanitizeBoard(body.board));
          push();
          return json({ ok: true });
        }
        // column-*: the same discipline as card-*, for the board's own shape.
        // These exist so the UI never has to send a whole board to rename a
        // column or drag one — each re-reads, applies one pure op, and writes.
        if (action === "column-add") {
          const name = typeof body.name === "string" ? body.name : "";
          const next = addColumn(readBoard(dir), name);
          writeBoard(dir, next);
          push();
          return json({ ok: true, columnId: next.columns[next.columns.length - 1]!.id });
        }
        if (action === "column-update" || action === "column-delete" || action === "column-reorder") {
          const columnId = typeof body.columnId === "string" ? body.columnId : "";
          const board = readBoard(dir);
          if (!board.columns.some((c) => c.id === columnId)) {
            return json({ ok: false, error: `unknown column: ${columnId}` }, 404);
          }
          if (action === "column-update") {
            const hasName = typeof body.name === "string";
            const hasInstruction = typeof body.instruction === "string";
            if (!hasName && !hasInstruction) return json({ ok: false, error: "name or instruction is required" }, 400);
            let next = board;
            if (hasName) next = renameColumn(next, columnId, body.name as string);
            if (hasInstruction) next = setInstruction(next, columnId, body.instruction as string);
            writeBoard(dir, next);
            push();
            return json({ ok: true });
          }
          if (action === "column-delete") {
            // writeBoard falls back to the default board when none are left, so
            // deleting the last column would silently resurrect the stock four.
            if (board.columns.length <= 1) {
              return json({ ok: false, error: "cannot delete the last column" }, 400);
            }
            writeBoard(dir, deleteColumn(board, columnId));
            push();
            return json({ ok: true });
          }
          const toIndex = typeof body.toIndex === "number" ? body.toIndex : NaN;
          if (!Number.isInteger(toIndex)) return json({ ok: false, error: "toIndex must be an integer" }, 400);
          writeBoard(dir, reorderColumn(board, columnId, toIndex));
          push();
          return json({ ok: true });
        }
        // column-restore / card-restore: the undo half. The caller hands back the
        // thing it deleted, so the id, comments and assignee return with it
        // rather than coming back as a fresh empty card.
        if (action === "column-restore") {
          const column = sanitizeColumn(body.column);
          if (!column) return json({ ok: false, error: "a valid column is required" }, 400);
          const index = typeof body.index === "number" ? body.index : 0;
          const cards = Array.isArray(body.cards)
            ? (body.cards.map(sanitizeCard).filter(Boolean) as Card[])
            : [];
          writeBoard(dir, restoreColumn(readBoard(dir), column, index, cards));
          push();
          return json({ ok: true });
        }
        if (action === "card-restore") {
          const card = sanitizeCard(body.card);
          if (!card) return json({ ok: false, error: "a valid card is required" }, 400);
          const index = typeof body.index === "number" ? body.index : 0;
          writeBoard(dir, restoreCard(readBoard(dir), card, index));
          push();
          return json({ ok: true });
        }
        // card-*: the write half of the agent card API. Each op re-reads the
        // board and applies one pure, card-scoped mutation before persisting —
        // so an agent's move/comment can never clobber (or be clobbered by)
        // another writer the way a whole-board write can. Not tied to a
        // sessionId: the author is a display name carried on the comment.
        if (action === "card-add") {
          const columnId = typeof body.columnId === "string" ? body.columnId : "";
          const title = typeof body.title === "string" ? body.title.trim() : "";
          if (!title) return json({ ok: false, error: "title is required" }, 400);
          const board = readBoard(dir);
          if (!board.columns.some((c) => c.id === columnId)) return json({ ok: false, error: `unknown column: ${columnId}` }, 400);
          let next = addCard(board, columnId, title);
          const card = next.cards[next.cards.length - 1]!; // addCard appends
          const description = typeof body.description === "string" ? body.description : "";
          if (description.trim()) next = setCardDescription(next, card.id, description);
          writeBoard(dir, next);
          push();
          return json({ ok: true, cardId: card.id });
        }
        if (action === "card-move" || action === "card-comment" || action === "card-update" || action === "card-assign" || action === "send-task" || action === "card-delete" || action === "comment-delete") {
          const cardId = typeof body.cardId === "string" ? body.cardId : "";
          const board = readBoard(dir);
          const card = board.cards.find((k) => k.id === cardId);
          if (!card) return json({ ok: false, error: `unknown card: ${cardId}` }, 404);
          const title = card.title.trim() || "(untitled card)";
          if (action === "card-delete") {
            writeBoard(dir, deleteCard(board, cardId));
            push();
            return json({ ok: true });
          }
          if (action === "comment-delete") {
            const commentId = typeof body.commentId === "string" ? body.commentId : "";
            if (!commentId) return json({ ok: false, error: "commentId is required" }, 400);
            writeBoard(dir, deleteComment(board, cardId, commentId));
            push();
            return json({ ok: true });
          }
          if (action === "card-move") {
            const to = board.columns.find((c) => c.id === body.toColumnId);
            if (!to) return json({ ok: false, error: `unknown column: ${String(body.toColumnId)}` }, 400);
            const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : "someone";
            const toIndex = typeof body.toIndex === "number" && Number.isInteger(body.toIndex) ? body.toIndex : undefined;
            const next = moveCard(board, cardId, to.id, toIndex);
            writeBoard(dir, next);
            push();
            // The column id (not display name): unambiguous, and directly
            // reusable by the recipient in a card-move call of its own.
            notifyCardEvent(next, cardId, author, `[THE LINE] ${author} moved "${title}" to "${to.id}".`);
            return json({ ok: true });
          }
          // card-update: edit a card's own text — its title, its description, or
          // both. Each field is applied only when present, so renaming a card
          // can't wipe a description written by someone else (and vice versa).
          // Silent by design: text edits don't wake the assignee the way a move
          // or a comment does.
          if (action === "card-update") {
            const hasTitle = typeof body.title === "string";
            const hasDescription = typeof body.description === "string";
            if (!hasTitle && !hasDescription) return json({ ok: false, error: "title or description is required" }, 400);
            // A blank title would leave the card unidentifiable on the board.
            if (hasTitle && !body.title!.trim()) return json({ ok: false, error: "title cannot be blank" }, 400);
            let next = board;
            if (hasTitle) next = renameCard(next, cardId, body.title!.trim());
            if (hasDescription) next = setCardDescription(next, cardId, body.description!);
            writeBoard(dir, next);
            push();
            return json({ ok: true });
          }
          if (action === "card-comment") {
            const author = typeof body.author === "string" ? body.author.trim() : "";
            const text = typeof body.text === "string" ? body.text.trim() : "";
            if (!author || !text) return json({ ok: false, error: "author and text are required" }, 400);
            const next = addComment(board, cardId, author, text);
            writeBoard(dir, next);
            push();
            notifyCardEvent(next, cardId, author, `[THE LINE] ${author} commented on "${title}":\n${text}`);
            return json({ ok: true });
          }
          // send-task: compose the full protocol prompt server-side and type it
          // into the assigned live session's terminal. The curl targets in the
          // footer are this very server, taken from the request's own origin.
          if (action === "send-task") {
            const assignee = card.assignee;
            if (!assignee) return json({ ok: false, error: "card has no assignee" }, 400);
            const agent = readSnapshot(dir, Date.now()).agents.find((a) => a.sessionId === assignee.id);
            if (!agent) return json({ ok: false, error: `assignee "${assignee.name}" is not a live session` }, 404);
            // A session waiting on a dialog would take the typed task as
            // keystrokes ON the dialog (Enter approves it) — refuse instead.
            if (agent.state === "waiting") {
              return json({ ok: false, error: `${agent.name} is waiting on a prompt in its terminal — answer that first, then resend` }, 409);
            }
            const prompt = cardTaskPrompt(board, cardId, url.origin, agent.name);
            if (!prompt.trim()) return json({ ok: false, error: "card has no task text to send" }, 400);
            // Fresh delivery: clear the agent's context before the new task so
            // the previous ticket doesn't bleed into this one.
            const r = await deliverFresh(agent, prompt);
            if (!r.ok) return json(r, 502);
            const by = typeof body.author === "string" && body.author.trim() ? body.author.trim() : "You";
            writeBoard(dir, addComment(readBoard(dir), cardId, by, `Sent task to ${agent.name}.`));
            push();
            return json({ ok: true });
          }
          // card-assign: bind a LIVE session (resolved to its display name so
          // the label survives the session ending), or clear with null.
          if (body.sessionId === null) {
            writeBoard(dir, assignCard(board, cardId, null));
            push();
            return json({ ok: true });
          }
          if (!validSessionId(body.sessionId)) return json({ ok: false, error: "bad sessionId" }, 400);
          const resolved = resolveAssignee(dir, body.sessionId);
          if (!resolved) return json({ ok: false, error: "no session with that id" }, 404);
          writeBoard(dir, assignCard(board, cardId, resolved));
          push();
          return json({ ok: true });
        }
        // upload: save an image dropped/pasted into a chat to a temp file, and
        // return its path. Not tied to a session — the path is later prepended to
        // a prompt and typed into the terminal, where Claude Code reads it.
        if (action === "upload") {
          const name = typeof body.name === "string" ? body.name : "image";
          const type = typeof body.type === "string" ? body.type : "";
          const data = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
          if (!data) return json({ ok: false, error: "no image data" }, 400);
          const r = saveUpload(name, type, data);
          return json(r, r.ok ? 200 : 400);
        }
        if (!validSessionId(body.sessionId)) return json({ ok: false, error: "bad sessionId" }, 400);
        if (action === "rename") {
          // name must be a string (or absent = clear); a non-string would throw
          // inside setNameOverride (.trim()) and 500 the handler.
          if (body.name !== undefined && typeof body.name !== "string") {
            return json({ ok: false, error: "name must be a string" }, 400);
          }
          setNameOverride(dir, body.sessionId, body.name ?? null);
          push();
          return json({ ok: true });
        }
        if (action === "sprite") {
          if (typeof body.palette !== "number" || typeof body.gear !== "string") {
            return json({ ok: false, error: "palette and gear are required" }, 400);
          }
          const character = typeof body.body === "string" ? body.body : undefined;
          setSpriteOverride(dir, body.sessionId, { palette: body.palette, gear: body.gear, body: character });
          push();
          return json({ ok: true });
        }
        const status = loadStatus(dir, body.sessionId);
        if (!status) return json({ ok: false, error: "unknown session" }, 404);
        if (action === "focus") return json(await focusSession(status));
        if (action === "pause") return json(await interruptSession(status));
        if (action === "kill") return json(await killAgent(status));
        if (action === "prompt") {
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim()) return json({ ok: false, error: "empty prompt" }, 400);
          if (text.length > 10_000) return json({ ok: false, error: "prompt too long" }, 400);
          return json(await sendPrompt(status, text));
        }
        return json({ ok: false, error: "unknown action" }, 404);
      }

      // images the human dropped/pasted (chat attachments, ticket images, a
      // custom background). Served by BASENAME only — resolveUploadPath refuses
      // anything with a separator or dot segment, so this can't be walked out of
      // the upload dir into the filesystem.
      if (url.pathname.startsWith("/uploads/")) {
        const target = resolveUploadPath(url.pathname.slice("/uploads/".length));
        if (!target) return new Response("not found", { status: 404 });
        const file = Bun.file(target);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        // Uploads are content-addressed by timestamp and never rewritten, so
        // they cache hard — a ticket full of screenshots shouldn't refetch on
        // every poll.
        return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable" } });
      }

      // static
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(import.meta.dir, "..", "dist", path));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
  });

  // Close the fs.watch handle when the server stops, so repeated
  // makeServer() calls (e.g. across tests) don't leak OS watchers.
  const baseStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    watcher.close();
    if (scanTimer) clearInterval(scanTimer);
    if (idleTimer) clearInterval(idleTimer);
    return baseStop(closeActiveConnections);
  }) as typeof server.stop;

  return server;
}

if (import.meta.main) {
  const server = makeServer(Number(process.env.PORT ?? 4173), { scan: true });
  console.log(`Agent Workshop → http://localhost:${server.port}  (watching ${statusDir()}, scanning open sessions)`);
}
