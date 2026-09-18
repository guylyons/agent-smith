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
import { applyCrew, pickName, mintCrewId, findAssigneeSession, isAssigneeSession, addNote, CREW_ID_RE } from "./lib/crew";
import { sendTaskReadiness } from "./lib/sendTaskReady";
import { readBoard, writeBoard, boardFile, addCard, moveCard, moveToWorkColumn, addComment, assignCard, renameCard, setCardDescription, cardTaskPrompt, addColumn, renameColumn, setInstruction, setColumnStage, STAGES, deleteColumn, reorderColumn, restoreColumn, deleteCard, restoreCard, deleteComment, sanitizeCard, sanitizeColumn, setCardTouches, claimBlockReason, type Board, type Card, type Column, type Stage } from "./lib/board";
import { ALLOWED_MODELS, ALLOWED_PERMISSION_MODES, focusSession, interruptSession, killAgent, sendPrompt, sendFreshPrompt, spawnAgent } from "./ghostty";
import { readRepo } from "./repo";
import { readMergeState, mergeWork } from "./lib/merge";
import { saveUpload, resolveUploadPath } from "./lib/uploads";
import { chooseFolder } from "./lib/chooser";
import { initialIdle, onConnect, onDisconnect, shouldShutDown, type IdleState } from "./lib/idle";
import { matchPendingSpawns, sessionsNeedingOpeningPrompt, type PendingSpawn } from "./lib/spawnAssign";

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

/** Resolve a session id to an `{ id, name, crew? }` assignee, applying the
 *  same crew/persona/override name resolution the live view uses. Prefers the
 *  fresh snapshot, but falls back to the session's own on-disk status file when
 *  it isn't surfaced as live yet — so a NEW agent's self-assign at SessionStart
 *  can't lose the race with the snapshot and silently leave the card unassigned.
 *  The crew id is what lets the card follow the agent through a /clear (see
 *  src/lib/crew.ts). Returns null only when no status file exists for the id. */
export function resolveAssignee(dir: string, sessionId: string): { id: string; name: string; crew?: string } | null {
  const live = readSnapshot(dir, Date.now()).agents.find((a) => a.sessionId === sessionId);
  const raw = live ?? loadStatus(dir, sessionId);
  if (!raw) return null;
  const [resolved] = live ? [live] : applyOverrides(applyCrew(applyPersonas([raw], loadPersonas())), readOverrides(dir));
  if (!resolved) return null;
  return { id: resolved.sessionId, name: resolved.name, ...(resolved.crew ? { crew: resolved.crew.id } : {}) };
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
  // personas and crew resolve INSIDE applyOverrides so a name you typed
  // yourself wins: user override > crew name > persona name > inferRole > hashed
  return buildSnapshot(applyOverrides(applyCrew(applyPersonas(agents, loadPersonas())), readOverrides(dir)), now, {
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
    /** How a new session is launched. Injectable so tests don't drive Ghostty. */
    spawn?: typeof spawnAgent;
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
    scan = false, scanIntervalMs = 20_000, deliver = sendPrompt, deliverFresh = sendFreshPrompt, spawn = spawnAgent,
    onWindowsClosed, idleGraceMs = 5_000, idleStartupGraceMs = 30_000, idleCheckMs = 1_000,
  } = opts;
  const dir = ensureStatusDir();

  // ---- the inbox ----------------------------------------------------------
  // Board events for a session that can't be typed at right now. Only an IDLE
  // session is typed at: typing into a working one races its next permission
  // prompt, and typing into a waiting one presses keys ON the dialog (a live
  // run showed notifications auto-approving prompts, which cascaded into
  // runaway spawns). Everything else queues here and is drained two ways: the
  // session's Stop hook asks for it as the turn ends (POST /action/inbox-drain),
  // and, for a session without hooks, the next snapshot that shows it idle
  // types the backlog in. In memory only: the events are on the board anyway,
  // so a restart loses nothing the agent can't re-read.
  const inbox = new Map<string, string[]>();
  const enqueue = (sessionId: string, text: string) => {
    inbox.set(sessionId, [...(inbox.get(sessionId) ?? []), text]);
  };
  const drain = (sessionId: string): string[] => {
    const items = inbox.get(sessionId) ?? [];
    inbox.delete(sessionId);
    return items;
  };
  /** The live view plus each session's queued count, so the human can see a
   *  note is waiting to land rather than wondering whether it was heard. */
  const snapshot = (): Snapshot => {
    const snap = readSnapshot(dir, Date.now());
    return {
      ...snap,
      agents: snap.agents.map((a) => {
        const n = inbox.get(a.sessionId)?.length ?? 0;
        return n ? { ...a, inbox: n } : a;
      }),
    };
  };

  type Delivery = { sessionId: string; name: string; via: "typed" | "queued" };
  /** One notification to one session: typed now if it is idle (queued on a
   *  failed type), queued otherwise. Never throws. */
  async function deliverTo(target: AgentStatus, text: string): Promise<Delivery> {
    if (target.state === "idle") {
      const r = await deliver(target, text).catch(() => ({ ok: false }));
      if (r.ok) return { sessionId: target.sessionId, name: target.name, via: "typed" };
    }
    enqueue(target.sessionId, text);
    return { sessionId: target.sessionId, name: target.name, via: "queued" };
  }

  /** Flush queued items into any session that has since turned idle — the
   *  no-hook fallback. Whatever fails to type stays queued for next time. */
  async function flushIdle(agents: AgentStatus[]) {
    for (const a of agents) {
      if (a.state !== "idle") continue;
      const items = drain(a.sessionId);
      if (!items.length) continue;
      const r = await deliver(a, items.join("\n\n")).catch(() => ({ ok: false }));
      if (!r.ok) for (const t of items) enqueue(a.sessionId, t);
    }
  }

  /** Who did a thing on the board: a display name, plus the session when it is
   *  known — which is what lets the fan-out skip the actor reliably. */
  type Actor = { name: string; sessionId?: string };

  type Unsignable = { error: string; status: number };

  /** A signature read off a card write, before anyone asks it for anything in
   *  particular. Every write path — move, comment, merge, crew-note — takes the
   *  same four conventions, tried in this order:
   *    as: "assignee"  the card's own assignee, at its CURRENT desk name and
   *                    session (a /clear moves both; the crew id does not, so a
   *                    rename shows and we never sign with a stale session)
   *    sessionId       any session, live or on disk
   *    crew            a crew member named outright, by the id its SessionStart
   *                    context handed it
   *    author          a bare display name the caller vouches for — the human's
   *                    "You", or an agent that knows its codename
   *  Which fields a convention can fill differs, and that is the whole reason
   *  this returns a record rather than one value: `crew` knows an id but no
   *  name, `author` a name but no id. `resolveActor` and `resolveCrewId` below
   *  ask for one or the other and say plainly when the signature given cannot
   *  supply it — `via` is what lets them name the right reason.
   *  `card` is the card being written to when the caller already has it; a
   *  caller that doesn't (crew-note) passes `cardId` in the body instead. */
  type Signer = { via: "assignee" | "session" | "crew" | "author"; name?: string; sessionId?: string; crew?: string };

  function resolveSigner(
    body: { as?: unknown; sessionId?: unknown; crew?: unknown; cardId?: unknown; author?: unknown },
    card?: Card,
  ): Signer | Unsignable {
    if (body.as === "assignee") {
      const k = card ?? readBoard(dir).cards.find((c) => c.id === body.cardId);
      if (!k) return { error: `unknown card: ${typeof body.cardId === "string" ? body.cardId : ""}`, status: 404 };
      if (!k.assignee) return { error: "card has no assignee to sign as", status: 400 };
      const live = findAssigneeSession(readSnapshot(dir, Date.now()).agents, k.assignee);
      const fresh = live ?? resolveAssignee(dir, k.assignee.id);
      return {
        via: "assignee",
        name: fresh?.name ?? k.assignee.name,
        sessionId: live?.sessionId ?? k.assignee.id,
        crew: live?.crew?.id ?? k.assignee.crew,
      };
    }
    if (typeof body.sessionId === "string") {
      if (!validSessionId(body.sessionId)) return { error: "bad sessionId", status: 400 };
      const who = resolveAssignee(dir, body.sessionId);
      return who ? { via: "session", name: who.name, sessionId: who.id, crew: who.crew } : { error: "no session with that id", status: 404 };
    }
    if (typeof body.crew === "string") {
      return CREW_ID_RE.test(body.crew) ? { via: "crew", crew: body.crew } : { error: "bad crew id", status: 400 };
    }
    return { via: "author", name: typeof body.author === "string" ? body.author.trim() : "" };
  }

  /** The signer as a display name. Never fails: a signature that names nobody
   *  yields an empty name, and each write path decides what that means for it
   *  (a move says "someone", a merge "You", a comment refuses). */
  function resolveActor(card: Card, body: { as?: unknown; sessionId?: unknown; crew?: unknown; author?: unknown }): Actor | Unsignable {
    const signer = resolveSigner(body, card);
    return "error" in signer ? signer : { name: signer.name ?? "", sessionId: signer.sessionId };
  }

  /** Whose notes a crew-note write is for. Notes belong to a crew member, so
   *  unlike a comment this needs an id and not just a name — a signature that
   *  can only offer a name is turned away with the reason its own convention
   *  couldn't produce one. A session without a crew (no hooks) has nowhere to
   *  keep notes, and says so. */
  function resolveCrewId(body: { crew?: unknown; sessionId?: unknown; cardId?: unknown; as?: unknown }): { id: string } | Unsignable {
    const signer = resolveSigner(body);
    if ("error" in signer) return signer;
    if (signer.crew) return { id: signer.crew };
    if (signer.via === "session") return { error: "that session has no crew id (hooks not installed?)", status: 400 };
    if (signer.via === "assignee") return { error: "the card's assignee has no crew id", status: 400 };
    return { error: "a crew id, sessionId, or cardId with as: \"assignee\" is required", status: 400 };
  }

  // Wake the sessions that care about a card event, best-effort and without
  // blocking the response. Recipients: the card's live assignee plus every
  // live scrum-master session, minus the actor (matched by session id when
  // known, by display name otherwise). Each recipient is told whether an answer
  // is expected: the assignee is asked to reply to anything someone ELSE did
  // to its card; a scrum master gets everything as FYI. A forward move by a
  // non-assignee wakes nobody but the scrum master — there is nothing for the
  // worker to do about its card being accepted. ASCII-only text: the pty path
  // this may ride is known to mangle anything else.
  async function notifyCardEvent(
    board: Board, cardId: string, actor: Actor, text: string,
    opts: { kind: "comment" | "move"; direction?: "forward" | "back" } = { kind: "comment" },
  ): Promise<Delivery[]> {
    const card = board.cards.find((k) => k.id === cardId);
    if (!card) return [];
    const { agents } = readSnapshot(dir, Date.now());
    const isActor = (a: AgentStatus) => (actor.sessionId ? a.sessionId === actor.sessionId : a.name === actor.name);
    const out: Delivery[] = [];
    for (const a of agents) {
      if (isActor(a)) continue;
      const isAssignee = isAssigneeSession(card.assignee, a);
      if (isAssignee) {
        if (opts.kind === "move" && opts.direction !== "back") continue;
        const ask = opts.kind === "move"
          ? "(reply expected: this is rework -- pick the card back up and answer on it with a card-comment)"
          : "(reply expected: answer on the card with a card-comment)";
        out.push(await deliverTo(a, `${text}\n${ask}`));
      } else if (a.persona === "scrum-master") {
        out.push(await deliverTo(a, `${text}\n(FYI, no reply needed unless it raises a problem or asks you something)`));
      }
    }
    return out;
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

  // ---- spawned-for-a-card, waiting for its session --------------------------
  // "New agent for this card" can't assign at launch: the session id doesn't
  // exist yet. The SessionStart hook assigns from AGENT_CARD, but without hooks
  // nothing does, so /action/spawn records the intent here and each push
  // applies it once the session shows up (see src/lib/spawnAssign.ts). Any
  // card-assign on the card settles it first, so a hook's assign (or the
  // human's) is never written over. In memory: a restart just drops the
  // intent, leaving the card as unassigned as it was.
  let pendingSpawns: PendingSpawn[] = [];
  let settling = false;
  async function settleSpawns(agents: AgentStatus[]) {
    if (settling) return;
    settling = true;
    try {
      const opening = new Map<string, string>();
      for (const id of sessionsNeedingOpeningPrompt(pendingSpawns, agents)) {
        const first = (await readConversation(id)).messages.find((m) => m.role === "user");
        if (first) opening.set(id, first.text);
      }
      // No await from here on: the match and the writes see one board state.
      const { matches, keep } = matchPendingSpawns(pendingSpawns, agents, Date.now(), opening);
      pendingSpawns = keep;
      let wrote = false;
      for (const { spawn: p, sessionId } of matches) {
        const board = readBoard(dir);
        const card = board.cards.find((k) => k.id === p.cardId);
        if (!card || card.assignee?.id === sessionId) continue;
        // The same file-claim gate card-assign applies, unless the spawn was forced.
        if (!p.force && claimBlockReason(board, p.cardId)) continue;
        const who = resolveAssignee(dir, sessionId);
        if (!who) continue;
        writeBoard(dir, assignCard(board, p.cardId, who));
        wrote = true;
      }
      if (wrote) push();
    } finally {
      settling = false;
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    const snap = snapshot();
    // A session that just went idle may have notes waiting; type them in now.
    if (inbox.size) void flushIdle(snap.agents).catch(() => {});
    if (pendingSpawns.length) void settleSpawns(snap.agents).catch(() => {});
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
            send(snapshot()); // initial
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
        const { agents } = snapshot();
        return json({
          agents: agents.map(({ sessionId, name, role, state, doing, persona, crew, cwd, branch, inbox }) =>
            ({ sessionId, name, role, state, doing, persona, crew, cwd, branch, ...(inbox ? { inbox } : {}) })),
        });
      }

      // the persona picker's options
      if (url.pathname === "/personas") {
        // id/name/role/skills only — the prompt body is never sent to the browser
        return json(loadPersonas().map(({ id, name, role, skills }) => ({ id, name, role, skills })));
      }

      // Where a card's work actually lives: its assignee's working directory.
      // Read from the session's own status FILE rather than the live snapshot,
      // so a card whose agent has finished and gone still knows which branch
      // holds its work — which is exactly when you want to merge it.
      const cardWorkDir = (cardId: string): { cwd: string } | { error: string; status: number } => {
        const card = readBoard(dir).cards.find((k) => k.id === cardId);
        if (!card) return { error: `unknown card: ${cardId}`, status: 404 };
        if (!card.assignee) return { error: "card has no assignee, so there's no branch to merge", status: 400 };
        // The crew member's current session first (its id moved on with a
        // /clear), then the session the card was bound to.
        const st = findAssigneeSession(readSnapshot(dir, Date.now()).agents, card.assignee) ?? loadStatus(dir, card.assignee.id);
        if (!st?.cwd) return { error: `no working directory known for ${card.assignee.name}`, status: 404 };
        return { cwd: st.cwd };
      };

      // whether a card's work is committed and can be landed on the trunk —
      // what puts the MERGE key on the card (and what greys it out)
      if (url.pathname === "/merge-state") {
        const where = cardWorkDir(url.searchParams.get("cardId") ?? "");
        if ("error" in where) return json({ error: where.error }, where.status);
        return json(await readMergeState(where.cwd));
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
        let body: { sessionId?: string | null; name?: string; text?: string; cwd?: string; palette?: number; gear?: string; body?: string; model?: string; permissionMode?: string; worktree?: string; branch?: string; persona?: string; type?: string; dataBase64?: string; cardId?: string; columnId?: string; toColumnId?: string; title?: string; description?: string; author?: string; instruction?: string; toIndex?: number; index?: number; column?: unknown; card?: unknown; cards?: unknown; commentId?: string; as?: string; stage?: string | null; crew?: string; replace?: boolean; touches?: unknown; force?: boolean };
        try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
        // pick-folder opens the real macOS folder chooser on the user's screen and
        // hands back the path they picked. Browser-only on purpose: it puts a
        // modal window on someone's desktop, so it takes a same-origin POST from
        // our own page — a scripted client (curl, an agent) sends no
        // sec-fetch-site and is refused rather than allowed through the way the
        // read endpoints are.
        if (action === "pick-folder") {
          if (req.headers.get("sec-fetch-site") !== "same-origin") {
            return json({ ok: false, error: "the folder picker is a browser-only action" }, 403);
          }
          return json(await chooseFolder(typeof body.cwd === "string" ? body.cwd : undefined));
        }
        // spawn creates a brand-new session — it has a folder + task, not a sessionId
        if (action === "spawn") {
          const cwd = typeof body.cwd === "string" ? body.cwd : "";
          const task = typeof body.text === "string" ? body.text : "";
          if (!cwd || !task.trim()) return json({ ok: false, error: "folder and task are required" }, 400);
          // The card this agent is being spawned for, if any: rides into the
          // session env so its SessionStart hook self-assigns the card once the
          // real session id exists, and is recorded below so the server does
          // the same when there are no hooks (see pendingSpawns).
          const cardId = typeof body.cardId === "string" && body.cardId.trim() ? body.cardId.trim() : undefined;
          // File-claim gate. Staffing a card whose `touches` overlap those of
          // another active, unmerged card is what puts two agents on a collision
          // course, so it is refused here — before a worktree, a branch or a
          // terminal exists. `force` is the human's override.
          if (cardId && body.force !== true) {
            const blocked = claimBlockReason(readBoard(dir), cardId);
            if (blocked) return json({ ok: false, error: blocked }, 409);
          }
          try { if (!statSync(cwd).isDirectory()) throw 0; } catch { return json({ ok: false, error: `folder not found: ${cwd}` }, 400); }
          const model = typeof body.model === "string" && ALLOWED_MODELS.has(body.model) ? body.model : undefined;
          const permissionMode = typeof body.permissionMode === "string" && ALLOWED_PERMISSION_MODES.has(body.permissionMode) ? body.permissionMode : undefined;
          // A blank/whitespace field means "no worktree" (launch in the folder). The
          // name is sanitized to a slug inside createWorktree, so pass it as typed.
          const worktree = typeof body.worktree === "string" && body.worktree.trim() ? body.worktree.trim() : undefined;
          // Same rule for the branch, and the two are independent: a branch on
          // its own switches the folder itself, a branch alongside a worktree
          // names that worktree's branch (see prepareLaunch).
          const branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : undefined;
          const persona = typeof body.persona === "string" && body.persona.trim() ? body.persona.trim() : undefined;
          // Loop-breaker: an agent (curl sends no sec-fetch-site) may spawn
          // workers but never another orchestrator. A live run showed confused
          // scrum-masters spawning scrum-masters exponentially; only a human in
          // the browser may start one.
          if (persona === "scrum-master" && !req.headers.get("sec-fetch-site")) {
            return json({ ok: false, error: "agents may not spawn a scrum-master — only a human can (use the + NEW AGENT dialog)" }, 403);
          }
          // Who the new agent is: a roster name no live desk is using, and a
          // crew id it keeps across every /clear (see src/lib/crew.ts).
          const live = readSnapshot(dir, Date.now()).agents;
          const name = pickName(live.map((a) => a.name));
          const crew = { id: mintCrewId(name), name };
          const r = await spawn(cwd, task, { model, permissionMode, worktree, branch, persona, serverUrl: url.origin, cardId, crew });
          // Bind the card to the new session once it shows up, hooks or not.
          if (r.ok && cardId && r.cwd) {
            pendingSpawns.push({
              cardId, cwd: r.cwd, uniqueCwd: r.worktreeCreated === true, crewId: crew.id, task,
              before: live.map((a) => a.sessionId), at: Date.now(), force: body.force === true,
            });
          }
          return json(r);
        }
        // There is deliberately no whole-board write: a writer holding a stale
        // board would silently erase whatever landed since it read.
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
            const hasStage = body.stage !== undefined;
            if (!hasName && !hasInstruction && !hasStage) return json({ ok: false, error: "name, instruction or stage is required" }, 400);
            if (hasStage && body.stage !== null && !(STAGES as readonly string[]).includes(body.stage as string)) {
              return json({ ok: false, error: `stage must be one of ${STAGES.join(", ")} or null` }, 400);
            }
            let next = board;
            if (hasName) next = renameColumn(next, columnId, body.name as string);
            if (hasInstruction) next = setInstruction(next, columnId, body.instruction as string);
            if (hasStage) next = setColumnStage(next, columnId, body.stage as Stage | null);
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
        if (action === "card-move" || action === "card-comment" || action === "card-update" || action === "card-assign" || action === "send-task" || action === "card-merge" || action === "card-delete" || action === "comment-delete") {
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
            const actor = resolveActor(card, body);
            if ("error" in actor) return json({ ok: false, error: actor.error }, actor.status);
            if (!actor.name) actor.name = "someone";
            const toIndex = typeof body.toIndex === "number" && Number.isInteger(body.toIndex) ? body.toIndex : undefined;
            const fromIndex = board.columns.findIndex((c) => c.id === card.columnId);
            const direction = board.columns.indexOf(to) < fromIndex ? "back" : "forward";
            const next = moveCard(board, cardId, to.id, toIndex);
            writeBoard(dir, next);
            push();
            // The column id (not display name): unambiguous, and directly
            // reusable by the recipient in a card-move call of its own.
            const delivery = await notifyCardEvent(next, cardId, actor, `[THE LINE] ${actor.name} moved "${title}" to "${to.id}".`, { kind: "move", direction });
            return json({ ok: true, delivery });
          }
          // card-update: edit a card's own text — its title, its description, or
          // both. Each field is applied only when present, so renaming a card
          // can't wipe a description written by someone else (and vice versa).
          // Silent by design: text edits don't wake the assignee the way a move
          // or a comment does.
          if (action === "card-update") {
            const hasTitle = typeof body.title === "string";
            const hasDescription = typeof body.description === "string";
            const hasTouches = body.touches !== undefined;
            if (!hasTitle && !hasDescription && !hasTouches) return json({ ok: false, error: "title, description or touches is required" }, 400);
            // A blank title would leave the card unidentifiable on the board.
            if (hasTitle && !body.title!.trim()) return json({ ok: false, error: "title cannot be blank" }, 400);
            // touches is the card's file claim: a list of paths/globs. An empty
            // list is how you clear it; anything else is a malformed edit.
            if (hasTouches && (!Array.isArray(body.touches) || body.touches.some((t: unknown) => typeof t !== "string"))) {
              return json({ ok: false, error: "touches must be a list of file paths or globs" }, 400);
            }
            let next = board;
            if (hasTitle) next = renameCard(next, cardId, body.title!.trim());
            if (hasDescription) next = setCardDescription(next, cardId, body.description!);
            if (hasTouches) next = setCardTouches(next, cardId, body.touches as string[]);
            writeBoard(dir, next);
            push();
            return json({ ok: true });
          }
          // card-merge: land this card's branch on the trunk, for real. The
          // guard rails live in lib/merge (nothing to merge, dirty tree, busy
          // main checkout, conflicts) — this only resolves the card to a
          // directory and records what happened on the card itself, so the
          // ticket carries the trail rather than just a toast that scrolls away.
          //
          // Browser-only, like the folder picker: this writes to the human's
          // own checkout and their history, and the board protocol has agents
          // hand work to Review for a person to accept. An agent (curl, no
          // sec-fetch-site) is refused rather than allowed to land its own work.
          if (action === "card-merge") {
            if (req.headers.get("sec-fetch-site") !== "same-origin") {
              return json({ ok: false, error: "merging is a human's call — press MERGE on the card in the dashboard" }, 403);
            }
            const where = cardWorkDir(cardId);
            if ("error" in where) return json({ ok: false, error: where.error }, where.status);
            // Signed like any other card write, and resolved BEFORE the merge:
            // a signature we can't honour should cost nothing, not leave the
            // trunk moved with no record on the card of who moved it. The
            // browser sends author: "You"; unsigned falls back to the same.
            const actor = resolveActor(card, body);
            if ("error" in actor) return json({ ok: false, error: actor.error }, actor.status);
            const by = actor.name || "You";
            const r = await mergeWork(where.cwd);
            if (!r.ok) return json(r, 409);
            const note = `Merged ${r.branch} into ${r.base}.`;
            const next = addComment(readBoard(dir), cardId, by, note);
            writeBoard(dir, next);
            push();
            void notifyCardEvent(next, cardId, { ...actor, name: by }, `[THE LINE] ${by} merged "${title}" -- ${note}`, { kind: "move", direction: "forward" });
            return json(r);
          }
          if (action === "card-comment") {
            const actor = resolveActor(card, body);
            if ("error" in actor) return json({ ok: false, error: actor.error }, actor.status);
            const text = typeof body.text === "string" ? body.text.trim() : "";
            if (!actor.name || !text) return json({ ok: false, error: "a signature (author, sessionId or as: \"assignee\") and text are required" }, 400);
            const next = addComment(board, cardId, actor.name, text);
            writeBoard(dir, next);
            push();
            const delivery = await notifyCardEvent(next, cardId, actor, `[THE LINE] ${actor.name} commented on "${title}":\n${text}`, { kind: "comment" });
            return json({ ok: true, delivery });
          }
          // send-task: compose the full protocol prompt server-side and type it
          // into the assigned live session's terminal. The curl targets in the
          // footer are this very server, taken from the request's own origin.
          if (action === "send-task") {
            // The same readiness rule the SEND TASK button asks
            // (src/lib/sendTaskReady.ts), so the two can't drift apart.
            const readiness = sendTaskReadiness(card.assignee, readSnapshot(dir, Date.now()).agents);
            if (!readiness.ready) {
              switch (readiness.why) {
                case "unassigned": return json({ ok: false, error: "card has no assignee" }, 400);
                case "ended": return json({ ok: false, error: `assignee "${readiness.assignee.name}" is not a live session` }, 404);
                // A session waiting on a dialog would take the typed task as
                // keystrokes ON the dialog (Enter approves it) — refuse instead.
                case "waiting": return json({ ok: false, error: `${readiness.agent.name} is waiting on a prompt in its terminal — answer that first, then resend` }, 409);
                // And a working one would have its context cleared mid-task.
                case "working": return json({ ok: false, error: `${readiness.agent.name} is still working — wait for it to go idle (or pause it), then resend` }, 409);
              }
            }
            const agent = readiness.agent;
            // An agent that already left comments here has worked this card
            // before: its context is about to be cleared, so the footer sends
            // it back to its own notes on the card first.
            const workedBefore = (card.comments ?? []).some((c) => c.author === agent.name);
            // Server-authoritative in-progress: put the card where work happens
            // ourselves, then compose the prompt from THAT board — so the card
            // reaches in-progress even if the agent skips STEP 1, and the prompt
            // correctly tells it the card is already there (leave it, pick it up).
            const progressed = moveToWorkColumn(board, cardId);
            const prompt = cardTaskPrompt(progressed, cardId, url.origin, agent.name, { workedBefore });
            if (!prompt.trim()) return json({ ok: false, error: "card has no task text to send" }, 400);
            // Fresh delivery: clear the agent's context before the new task so
            // the previous ticket doesn't bleed into this one.
            const r = await deliverFresh(agent, prompt);
            if (!r.ok) return json(r, 502); // delivery failed: leave the card where it was
            const by = typeof body.author === "string" && body.author.trim() ? body.author.trim() : "You";
            // Re-read after the await, then apply the move + the send record as one
            // write (moveToWorkColumn is a no-op if it already landed in-progress).
            writeBoard(dir, addComment(moveToWorkColumn(readBoard(dir), cardId), cardId, by, `Sent task to ${agent.name}.`));
            push();
            return json({ ok: true });
          }
          // card-assign: bind a LIVE session (resolved to its display name so
          // the label survives the session ending), or clear with null.
          if (body.sessionId === null) {
            pendingSpawns = pendingSpawns.filter((p) => p.cardId !== cardId);
            writeBoard(dir, assignCard(board, cardId, null));
            push();
            return json({ ok: true });
          }
          if (!validSessionId(body.sessionId)) return json({ ok: false, error: "bad sessionId" }, 400);
          // The same file-claim gate as spawn: binding an agent to this card is
          // staffing it. Unassigning (handled above) is never blocked — it is
          // how you get OUT of a conflict.
          if (body.force !== true) {
            const blocked = claimBlockReason(board, cardId);
            if (blocked) return json({ ok: false, error: blocked }, 409);
          }
          const resolved = resolveAssignee(dir, body.sessionId);
          if (!resolved) return json({ ok: false, error: "no session with that id" }, 404);
          pendingSpawns = pendingSpawns.filter((p) => p.cardId !== cardId);
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
        // crew-note: a crew member keeping its notes (see src/lib/crew.ts),
        // signed like a card write: by crew id (the SessionStart context hands
        // the agent its own), by session id, or as a card's assignee.
        if (action === "crew-note") {
          const crewId = resolveCrewId(body);
          if ("error" in crewId) return json({ ok: false, error: crewId.error }, crewId.status);
          const r = addNote(dir, crewId.id, typeof body.text === "string" ? body.text : "", { replace: body.replace === true });
          return json(r, r.ok ? 200 : 400);
        }
        if (!validSessionId(body.sessionId)) return json({ ok: false, error: "bad sessionId" }, 400);
        // inbox-drain: a session's Stop hook collecting the board events that
        // arrived while it was busy. Hands them over once; the hook feeds them
        // back to the agent as the reason its turn should continue.
        if (action === "inbox-drain") {
          const items = drain(body.sessionId);
          if (items.length) push();
          return json({ ok: true, items });
        }
        // A rename or a new look is stored against the crew member when the
        // session has one, so it survives the /clear that ends this session id.
        const overrideKey = (sessionId: string) => loadStatus(dir, sessionId)?.crew?.id ?? sessionId;
        if (action === "rename") {
          // name must be a string (or absent = clear); a non-string would throw
          // inside setNameOverride (.trim()) and 500 the handler.
          if (body.name !== undefined && typeof body.name !== "string") {
            return json({ ok: false, error: "name must be a string" }, 400);
          }
          setNameOverride(dir, overrideKey(body.sessionId), body.name ?? null);
          push();
          return json({ ok: true });
        }
        if (action === "sprite") {
          if (typeof body.palette !== "number" || typeof body.gear !== "string") {
            return json({ ok: false, error: "palette and gear are required" }, 400);
          }
          const character = typeof body.body === "string" ? body.body : undefined;
          setSpriteOverride(dir, overrideKey(body.sessionId), { palette: body.palette, gear: body.gear, body: character });
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
