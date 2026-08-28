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
import { readBoard, writeBoard, sanitizeBoard, boardFile, addCard, moveCard, addComment, assignCard, setCardDescription, cardTaskPrompt, type Board } from "./lib/board";
import { ALLOWED_MODELS, ALLOWED_PERMISSION_MODES, focusSession, interruptSession, killAgent, sendPrompt, sendFreshPrompt, spawnAgent } from "./ghostty";
import { readRepo } from "./repo";
import { saveUpload } from "./lib/uploads";

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
  } = {},
) {
  const { scan = false, scanIntervalMs = 20_000, deliver = sendPrompt, deliverFresh = sendFreshPrompt } = opts;
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

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    const snap = readSnapshot(dir, Date.now());
    for (const send of clients) {
      try {
        send(snap);
      } catch {
        // Client's controller is closed (cancel() hasn't fired yet) —
        // drop it so it isn't retried on the next push.
        clients.delete(send);
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
            clients.add(send);
            send(readSnapshot(dir, Date.now())); // initial
          },
          cancel() { clients.delete(send); },
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
        let body: { sessionId?: string | null; name?: string; text?: string; cwd?: string; palette?: number; gear?: string; body?: string; model?: string; permissionMode?: string; worktree?: string; persona?: string; board?: unknown; type?: string; dataBase64?: string; cardId?: string; columnId?: string; toColumnId?: string; title?: string; description?: string; author?: string };
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
        // board: the whole kanban board (THE LINE). The client owns the edit and
        // sends the full board; the server sanitizes it (dropping malformed
        // columns/cards, orphan cards) before persisting so a bad write can't
        // corrupt the file agents read. Not tied to a sessionId.
        if (action === "board") {
          writeBoard(dir, sanitizeBoard(body.board));
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
        if (action === "card-move" || action === "card-comment" || action === "card-assign" || action === "send-task") {
          const cardId = typeof body.cardId === "string" ? body.cardId : "";
          const board = readBoard(dir);
          const card = board.cards.find((k) => k.id === cardId);
          if (!card) return json({ ok: false, error: `unknown card: ${cardId}` }, 404);
          const title = card.title.trim() || "(untitled card)";
          if (action === "card-move") {
            const to = board.columns.find((c) => c.id === body.toColumnId);
            if (!to) return json({ ok: false, error: `unknown column: ${String(body.toColumnId)}` }, 400);
            const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : "someone";
            const next = moveCard(board, cardId, to.id);
            writeBoard(dir, next);
            push();
            // The column id (not display name): unambiguous, and directly
            // reusable by the recipient in a card-move call of its own.
            notifyCardEvent(next, cardId, author, `[THE LINE] ${author} moved "${title}" to "${to.id}".`);
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
    return baseStop(closeActiveConnections);
  }) as typeof server.stop;

  return server;
}

if (import.meta.main) {
  const server = makeServer(Number(process.env.PORT ?? 4173), { scan: true });
  console.log(`Agent Workshop → http://localhost:${server.port}  (watching ${statusDir()}, scanning open sessions)`);
}
