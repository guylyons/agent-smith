import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseStatus, type AgentStatus } from "./schema";
import { buildSnapshot, snapshotEvent, type Snapshot, type Sent } from "./lib/snapshot";
import { archivableIds, archiveCards, restoreArchivedCard, visibleArchive, readArchive, loadArchiveForWrite, writeArchive } from "./lib/archive";
import { remember, forget, compactMemory, memoryView, searchMemory, neighbours, formatResults, readMemory, loadMemoryForWrite, writeMemory, type FactKind } from "./lib/memory";
import { ensureStatusDir, statusDir } from "./lib/paths";
import { sandboxLeakWarning } from "./lib/sandbox";
import { scanLiveSessions, readConversation, readSubagents } from "./scan";
import { matchChat } from "./lib/chatsearch";
import type { ChatMessage } from "./lib/conversation";
import { readOverrides, applyOverrides, setNameOverride, setSpriteOverride } from "./lib/overrides";
import { loadPersonas, applyPersonas, spawnName } from "./lib/personas";
import { applyCrew, applyBoundCrews, readBoundCrews, recordBoundCrew, mintCrewId, findAssigneeSession, isAssigneeSession, isActorSession, scrumHears, addNote, CREW_ID_RE } from "./lib/crew";
import { sendTaskReadiness } from "./lib/sendTaskReady";
import { readBoard, writeBoard, boardFile, addCard, moveCard, moveToWorkColumn, addComment, assignCard, renameCard, setCardDescription, cardTaskPrompt, cardTaskFooter, addColumn, renameColumn, setInstruction, setColumnStage, deleteColumn, reorderColumn, restoreColumn, deleteCard, restoreCard, deleteComment, setCardTouches, setCardRepo, setCardKind, findScrumCard, cardView, scrumBrief, repoName, claimBlockReason, mergeBlockReason, landMergedCard, mergeReleaseNotes, finishesCard, isLandedColumn, type Board, type Card } from "./lib/board";
import { readMood, writeMood, moodFile, formatMood, addNote as addMoodNote, updateNote, raiseNote, deleteNote, restoreNote, addLink, linkBlockReason, setLinkLabel, deleteLink, type Mood, type MoodLink, type NotePatch } from "./lib/mood";
import { mainCheckout } from "./lib/worktree";
import { focusSession, interruptSession, killAgent, sendPrompt, sendFreshPrompt, spawnAgent } from "./ghostty";
import { readRepo } from "./repo";
import { readMergeState, readMergePreview, mergeWork, holdForClaims, cleanupMergedWork, planWorktreeCleanup, cleanupMergedWorktrees } from "./lib/merge";
import { saveUpload, resolveUploadPath } from "./lib/uploads";
import { chooseFolder } from "./lib/chooser";
import { initialIdle, onConnect, onDisconnect, shouldShutDown, type IdleState } from "./lib/idle";
import { matchPendingSpawns, sessionsNeedingOpeningPrompt, type PendingSpawn } from "./lib/spawnAssign";
import { dispatchAction, type ActionContext, type ActionHandler } from "./lib/actionDispatch";
import type { z } from "zod";
import {
  parseBody, SESSION_ID_RE, ColumnRef, CardRef, SessionRef, NoFields, type Signature,
  PickFolderBody, SpawnBody, ColumnAddBody, ColumnUpdateBody, ColumnReorderBody, ColumnRestoreBody,
  CardRestoreBody, ColumnArchiveBody, CardAddBody, CommentDeleteBody, CardMoveBody, CardUpdateBody, CardMergeBody,
  CardCommentBody, SendTaskBody, CardAssignBody, UploadBody, CrewNoteBody, RenameBody, SpriteBody, PromptBody,
  MoodNoteAddBody, MoodNoteRestoreBody, MoodNoteRef, MoodNoteUpdateBody, MoodLinkAddBody, MoodLinkRef, MoodLinkUpdateBody,
  MemoryAddBody, MemoryForgetBody, WorktreeCleanupBody,
} from "./lib/actionBodies";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// sessionId comes from the client; keep it to a single, safe path/key segment.
function validSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
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
  const [resolved] = live ? [live] : resolveNames(dir, [raw]);
  if (!resolved) return null;
  return { id: resolved.sessionId, name: resolved.name, ...(resolved.crew ? { crew: resolved.crew.id } : {}) };
}

/** Each agent's display name and crew. Personas and crew resolve INSIDE
 *  applyOverrides so a name you typed yourself wins:
 *  user override > crew name (reported, or bound at spawn) > persona name > inferRole > hashed */
function resolveNames(dir: string, agents: AgentStatus[]): AgentStatus[] {
  return applyOverrides(applyCrew(applyBoundCrews(applyPersonas(agents, loadPersonas()), readBoundCrews(dir))), readOverrides(dir));
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
  const snap = buildSnapshot(resolveNames(dir, agents), now, {
    board: readBoard(dir),
  });
  return { ...snap, mood: readMood(dir), archived: visibleArchive(snap.board, readArchive(dir)).length };
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

/** The JSON body any POST /action/* may carry; each handler reads its own
 *  fields and checks their types itself. */
/** The human's byline on the board: the browser signs their writes with it,
 *  and the dashboard reads it as "me". */
const HUMAN = "You";

/** An actor's name as an agent should read it. Typed into an agent's terminal,
 *  the human's "You" reads as the agent itself ("You merged ..."). */
function nameForAgents(name: string): string {
  return name === HUMAN ? "The user" : name;
}

/** Who signs the note a merge leaves on the cards it was holding up. */
const MERGE_NOTE_AUTHOR = "THE LINE";

/** How often the scanner re-reads ~/.claude/projects for live sessions — the
 *  main load-vs-responsiveness knob on a machine with many transcripts.
 *  Override with AGENT_SCAN_INTERVAL_MS; a missing, zero or non-numeric value
 *  keeps the default rather than spinning setInterval at ~0ms. */
const envScanMs = Number(process.env.AGENT_SCAN_INTERVAL_MS);
const SCAN_INTERVAL_MS = envScanMs > 0 ? envScanMs : 20_000;

/** Shown at / when dist/ hasn't been built yet. */
const UNBUILT_PAGE = `<!doctype html><meta charset="utf-8"><title>Agent Smith</title>
<body style="font:14px ui-monospace,monospace;padding:2em">
<p>The dashboard UI hasn't been built yet.</p>
<p>Run <code>bun run build</code> in this checkout, then reload.</p>`;

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
    /** How a session is ended once its card's work has merged (see
     *  cardMerge). Injectable so tests don't close real Ghostty tabs. */
    quit?: typeof killAgent;
    /** Opt-in, for the stand-alone app window (`bun run app`): called once the
     *  last dashboard window has been shut for `idleGraceMs`, or never opened
     *  within `idleStartupGraceMs`. Left unset, the server serves forever with
     *  no window attached — which is what `bun run dev` wants. */
    onWindowsClosed?: () => void;
    idleGraceMs?: number;
    idleStartupGraceMs?: number;
    idleCheckMs?: number;
    /** How often /events sends a keep-alive comment (see the stream below). */
    heartbeatMs?: number;
    /** Where the built UI lives. Injectable so tests needn't build it. */
    distDir?: string;
  } = {},
) {
  const {
    scan = false, scanIntervalMs = SCAN_INTERVAL_MS, deliver = sendPrompt, deliverFresh = sendFreshPrompt, spawn = spawnAgent, quit = killAgent,
    onWindowsClosed, idleGraceMs = 5_000, idleStartupGraceMs = 30_000, idleCheckMs = 1_000,
    heartbeatMs = 5_000, distDir = join(import.meta.dir, "..", "dist"),
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

  /** Who did a thing on the board: a display name, plus the session and crew
   *  when known — which is what lets the fan-out skip the actor reliably. */
  type Actor = { name: string; sessionId?: string; crew?: string };

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

  function resolveSigner(body: Signature, card?: Card): Signer | Unsignable {
    if (body.as === "assignee") {
      const k = card ?? readBoard(dir).cards.find((c) => c.id === body.cardId);
      if (!k) return { error: `unknown card: ${body.cardId ?? ""}`, status: 404 };
      if (!k.assignee) return { error: "card has no assignee to sign as", status: 400 };
      const live = findAssigneeSession(readSnapshot(dir, Date.now()).agents, k.assignee);
      // The assignee has ended and a new agent was spawned for the card but
      // hasn't bound yet: the caller is that agent, so sign with the name it
      // was launched under, not the ended assignee's.
      const respawn = live ? undefined : pendingSpawns.findLast((p) => p.cardId === k.id && p.crewName);
      // A caller that also says who it is (the footer adds its crew id) and is
      // not the assignee was taken off the card: signing it as the assignee
      // would put its words under the new agent's name. Without a crew id on
      // both sides there is nothing to compare, so old footers sign as before.
      const current = respawn?.crewId ?? live?.crew?.id ?? k.assignee.crew;
      if (body.crew && CREW_ID_RE.test(body.crew) && current && body.crew !== current) {
        return { error: "you are no longer assigned to this card; stop work on it", status: 409 };
      }
      if (respawn) return { via: "assignee", name: respawn.crewName, crew: respawn.crewId };
      const fresh = live ?? resolveAssignee(dir, k.assignee.id);
      return {
        via: "assignee",
        name: fresh?.name ?? k.assignee.name,
        sessionId: live?.sessionId ?? k.assignee.id,
        crew: live?.crew?.id ?? k.assignee.crew,
      };
    }
    if (body.sessionId !== undefined) {
      if (!validSessionId(body.sessionId)) return { error: "bad sessionId", status: 400 };
      const who = resolveAssignee(dir, body.sessionId);
      return who ? { via: "session", name: who.name, sessionId: who.id, crew: who.crew } : { error: "no session with that id", status: 404 };
    }
    if (body.crew !== undefined) {
      // With an author too (the footer's fallback swaps "as" for "author" and
      // leaves the crew id in), the name comes from the author.
      return CREW_ID_RE.test(body.crew) ? { via: "crew", crew: body.crew, name: body.author || undefined } : { error: "bad crew id", status: 400 };
    }
    return { via: "author", name: body.author };
  }

  /** The signer as a display name. Never fails: a signature that names nobody
   *  yields an empty name, and each write path decides what that means for it
   *  (a move says "someone", a merge "You", a comment refuses). */
  function resolveActor(card: Card, body: Signature): Actor | Unsignable {
    const signer = resolveSigner(body, card);
    return "error" in signer ? signer : { name: signer.name ?? "", sessionId: signer.sessionId, crew: signer.crew };
  }

  /** Whose notes a crew-note write is for. Notes belong to a crew member, so
   *  unlike a comment this needs an id and not just a name — a signature that
   *  can only offer a name is turned away with the reason its own convention
   *  couldn't produce one. A session without a crew (no hooks) has nowhere to
   *  keep notes, and says so. */
  function resolveCrewId(body: Signature): { id: string } | Unsignable {
    const signer = resolveSigner(body);
    if ("error" in signer) return signer;
    if (signer.crew) return { id: signer.crew };
    if (signer.via === "session") return { error: "that session has no crew id (hooks not installed?)", status: 400 };
    if (signer.via === "assignee") return { error: "the card's assignee has no crew id", status: 400 };
    return { error: "a crew id, sessionId, or cardId with as: \"assignee\" is required", status: 400 };
  }

  // Wake the sessions that care about a card event, best-effort and without
  // blocking the response. Recipients: the card's live assignee plus the live
  // scrum-master sessions for the card's project (see scrumHears), minus the
  // actor (see isActor). Each recipient is told whether an answer
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
    const isActor = (a: AgentStatus) => isActorSession(actor, a);
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
      } else if (a.persona === "scrum-master" && scrumHears(board, a, card)) {
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
        if (!card) continue;
        // A session without hooks never reports the crew it was launched as;
        // record it, so its desk and its signature use the name it was told.
        const matched = agents.find((a) => a.sessionId === sessionId);
        if (matched && !matched.crew && p.crewId && p.crewName) {
          recordBoundCrew(dir, sessionId, { id: p.crewId, name: p.crewName });
          wrote = true;
        }
        if (card.assignee?.id === sessionId) continue;
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

  // A finished card has no more use for its agent: when a card is moved into
  // Done (or past it) its assignee's session is ended through `quit`, the same
  // kill the desk's ✕ runs. A card-merge ends its own session (see cardMerge). The dashboard sees the move in its next snapshot and
  // plays the tube death (see finishedAssignees). Best effort — a session
  // already gone, or a terminal we can't find, just stays as it is.
  const endFinishedSession = async (before: Board, cardId: string, toColumnId: string): Promise<boolean> => {
    const card = before.cards.find((k) => k.id === cardId);
    if (!card?.assignee || !finishesCard(before, card.columnId, toColumnId)) return false;
    const st = findAssigneeSession(readSnapshot(dir, Date.now()).agents, card.assignee) ?? loadStatus(dir, card.assignee.id);
    if (!st) return false;
    try { return (await quit(st)).ok; } catch { return false; }
  };

  // ---- POST /action/* handlers ------------------------------------------------
  // One named function per action, wired up in `actionHandlers` below. The
  // CSRF gate and the JSON parse live in dispatchAction (src/lib/actionDispatch.ts),
  // wrapped around the lookup, so no handler here can be reached without them.
  // What the body must hold is declared per action in src/lib/actionBodies.ts;
  // the raw body stays `unknown` until one of those schemas has read it.
  type Ctx = ActionContext<unknown>;
  type Result = Response | Promise<Response>;

  /** Read the body with the action's schema, answering 400 with the schema's
   *  own message when it breaks a rule. */
  const withBody = <S extends z.ZodType>(schema: S, fn: (ctx: Ctx, body: z.output<S>) => Result): ActionHandler<unknown> =>
    (ctx) => {
      const r = parseBody(schema, ctx.body);
      return "error" in r ? json({ ok: false, error: r.error }, 400) : fn(ctx, r.data);
    };

  // Shared preambles. Each reads what a family of actions needs, answers the
  // unhappy path itself, and only then reads the rest of the body with the
  // action's own schema — so a missing card or column is reported ahead of a
  // malformed field, as it always has been.

  /** column-update/-delete/-reorder: the column must exist on a fresh read. */
  const withColumn = <S extends z.ZodType>(schema: S, fn: (ctx: Ctx, body: z.output<S>, board: Board, columnId: string) => Result) =>
    withBody(ColumnRef, (ctx, { columnId }) => {
      const board = readBoard(dir);
      if (!board.columns.some((c) => c.id === columnId)) {
        return json({ ok: false, error: `unknown column: ${columnId}` }, 404);
      }
      return withBody(schema, (ctx, body) => fn(ctx, body, board, columnId))(ctx);
    });

  /** card-*: the write half of the agent card API. Each op re-reads the
   *  board and applies one pure, card-scoped mutation before persisting —
   *  so an agent's move/comment can never clobber (or be clobbered by)
   *  another writer the way a whole-board write can. Not tied to a
   *  sessionId: the author is a display name carried on the comment. */
  const withCard = <S extends z.ZodType>(schema: S, fn: (ctx: Ctx, body: z.output<S>, card: Card, board: Board, title: string) => Result) =>
    withBody(CardRef, (ctx, { cardId }) => {
      const board = readBoard(dir);
      const card = board.cards.find((k) => k.id === cardId);
      if (!card) return json({ ok: false, error: `unknown card: ${cardId}` }, 404);
      return withBody(schema, (ctx, body) => fn(ctx, body, card, board, card.title.trim() || "(untitled card)"))(ctx);
    });

  /** Actions about one session, by id. */
  const withSessionId = <S extends z.ZodType>(schema: S, fn: (ctx: Ctx, body: z.output<S>, sessionId: string) => Result) =>
    withBody(SessionRef, (ctx, { sessionId }) => withBody(schema, (ctx, body) => fn(ctx, body, sessionId))(ctx));

  /** Actions that drive a session's terminal: it must have a status file. */
  const withSessionStatus = <S extends z.ZodType>(schema: S, fn: (ctx: Ctx, body: z.output<S>, status: AgentStatus) => Result) =>
    withSessionId(schema, (ctx, body, sessionId) => {
      const status = loadStatus(dir, sessionId);
      if (!status) return json({ ok: false, error: "unknown session" }, 404);
      return fn(ctx, body, status);
    });

  // pick-folder opens the real macOS folder chooser on the user's screen and
  // hands back the path they picked. Browser-only on purpose: it puts a
  // modal window on someone's desktop, so it takes a same-origin POST from
  // our own page — a scripted client (curl, an agent) sends no
  // sec-fetch-site and is refused rather than allowed through the way the
  // read endpoints are.
  async function pickFolder({ req }: Ctx, body: z.output<typeof PickFolderBody>): Promise<Response> {
    if (req.headers.get("sec-fetch-site") !== "same-origin") {
      return json({ ok: false, error: "the folder picker is a browser-only action" }, 403);
    }
    return json(await chooseFolder(body.cwd));
  }

  // spawn creates a brand-new session — it has a folder + task, not a sessionId
  async function spawnSession({ req, url }: Ctx, body: z.output<typeof SpawnBody>): Promise<Response> {
    const { cwd, text: task, cardId, model, permissionMode, worktree, branch, persona } = body;
    // The card this agent is being spawned for, if any: rides into the
    // session env so its SessionStart hook self-assigns the card once the
    // real session id exists, and is recorded below so the server does
    // the same when there are no hooks (see pendingSpawns).
    // File-claim gate. Staffing a card whose `touches` overlap those of
    // another active, unmerged card is what puts two agents on a collision
    // course, so it is refused here — before a worktree, a branch or a
    // terminal exists. `force` is the human's override.
    if (cardId && !body.force) {
      const blocked = claimBlockReason(readBoard(dir), cardId);
      if (blocked) return json({ ok: false, error: blocked }, 409);
    }
    try { if (!statSync(cwd).isDirectory()) throw 0; } catch { return json({ ok: false, error: `folder not found: ${cwd}` }, 400); }
    // model/permissionMode arrive already narrowed to the allowed sets. A
    // blank worktree means "no worktree" (launch in the folder); a blank
    // branch likewise, and the two are independent: a branch on its own
    // switches the folder itself, a branch alongside a worktree names that
    // worktree's branch (see prepareLaunch).
    // Loop-breaker: an agent (curl sends no sec-fetch-site) may spawn
    // workers but never another orchestrator. A live run showed confused
    // scrum-masters spawning scrum-masters exponentially; only a human in
    // the browser may start one.
    if (persona === "scrum-master" && !req.headers.get("sec-fetch-site")) {
      return json({ ok: false, error: "agents may not spawn a scrum-master — only a human can (use the + NEW AGENT dialog)" }, 403);
    }
    // Who the new agent is: its persona's fixed name, else a roster name no
    // live desk is using (see spawnName), and a crew id it keeps across
    // every /clear (see src/lib/crew.ts).
    const live = readSnapshot(dir, Date.now()).agents;
    const personas = loadPersonas();
    // A spawn not yet bound to its session still holds its name, or two quick
    // spawns into one persona would both be told the same one.
    const name = spawnName(persona, personas, [...live.map((a) => a.name), ...pendingSpawns.flatMap((p) => (p.crewName ? [p.crewName] : []))]);
    const cast = persona ? personas.find((p) => p.id === persona) : undefined;
    const crew = { id: mintCrewId(name), name };
    // A worker an agent staffs (the scrum master's spawn) runs in auto mode
    // unless the spawn names a mode, so it doesn't stall on prompts nobody is
    // watching. A human in the dialog gets exactly the mode they picked.
    const mode = permissionMode ?? (req.headers.get("sec-fetch-site") ? undefined : "auto");
    // The persona's model is only a default: one picked at launch wins.
    // A card spawn by curl (the scrum master staffing a card) sends plain
    // text; the browser sends the full prompt, whose footer was built before
    // this agent had a name or crew id. Either way the agent gets the card's
    // protocol footer exactly once, ours: it carries the crew id, so the
    // agent's writes are refused once it is taken off the card.
    const footer = cardId ? cardTaskFooter(readBoard(dir), cardId, url.origin, name, { crew: crew.id }) : "";
    const cut = footer ? task.indexOf("-- THE LINE --") : -1;
    const taskText = cut === -1 ? task : task.slice(0, cut).trimEnd();
    const sent = footer ? `${taskText}\n\n${footer}` : task;
    const r = await spawn(cwd, sent, { model: model ?? cast?.model, permissionMode: mode, worktree, branch, persona, serverUrl: url.origin, cardId, crew });
    // Bind the card to the new session once it shows up, hooks or not.
    if (r.ok && cardId && r.cwd) {
      pendingSpawns.push({
        cardId, cwd: r.cwd, uniqueCwd: r.worktreeCreated === true, crewId: crew.id, crewName: crew.name, task: sent,
        before: live.map((a) => a.sessionId), at: Date.now(), force: body.force,
      });
    }
    // Label the card with the repo it is being worked in, unless someone
    // already has. The main checkout, not the worktree: the label names the
    // project, and every worktree of it should read the same.
    if (r.ok && cardId && !readBoard(dir).cards.find((k) => k.id === cardId)?.repo) {
      const root = await mainCheckout(cwd);
      const board = readBoard(dir); // re-read: the git call above yielded
      if (board.cards.some((k) => k.id === cardId && !k.repo)) {
        writeBoard(dir, setCardRepo(board, cardId, repoName(root), root));
        push();
      }
    }
    return json(r);
  }

  // There is deliberately no whole-board write: a writer holding a stale
  // board would silently erase whatever landed since it read.
  // column-*: the same discipline as card-*, for the board's own shape.
  // These exist so the UI never has to send a whole board to rename a
  // column or drag one — each re-reads, applies one pure op, and writes.
  function columnAdd(_ctx: Ctx, { name }: z.output<typeof ColumnAddBody>): Response {
    const next = addColumn(readBoard(dir), name);
    writeBoard(dir, next);
    push();
    return json({ ok: true, columnId: next.columns[next.columns.length - 1]!.id });
  }

  // Each field is applied only when present; ColumnUpdateBody requires one.
  function columnUpdate(_ctx: Ctx, body: z.output<typeof ColumnUpdateBody>, board: Board, columnId: string): Response {
    let next = board;
    if (body.name !== undefined) next = renameColumn(next, columnId, body.name);
    if (body.instruction !== undefined) next = setInstruction(next, columnId, body.instruction);
    if (body.stage !== undefined) next = setColumnStage(next, columnId, body.stage);
    writeBoard(dir, next);
    push();
    return json({ ok: true });
  }

  function columnDelete(_ctx: Ctx, _body: unknown, board: Board, columnId: string): Response {
    // writeBoard falls back to the default board when none are left, so
    // deleting the last column would silently resurrect the stock four.
    if (board.columns.length <= 1) {
      return json({ ok: false, error: "cannot delete the last column" }, 400);
    }
    writeBoard(dir, deleteColumn(board, columnId));
    push();
    return json({ ok: true });
  }

  function columnReorder(_ctx: Ctx, { toIndex }: z.output<typeof ColumnReorderBody>, board: Board, columnId: string): Response {
    writeBoard(dir, reorderColumn(board, columnId, toIndex));
    push();
    return json({ ok: true });
  }

  // column-restore / card-restore: the undo half. The caller hands back the
  // thing it deleted, so the id, comments and assignee return with it
  // rather than coming back as a fresh empty card.
  function columnRestore(_ctx: Ctx, { column, index, cards }: z.output<typeof ColumnRestoreBody>): Response {
    writeBoard(dir, restoreColumn(readBoard(dir), column, index, cards));
    push();
    return json({ ok: true });
  }

  function cardRestore(_ctx: Ctx, { card, index }: z.output<typeof CardRestoreBody>): Response {
    writeBoard(dir, restoreCard(readBoard(dir), card, index));
    push();
    return json({ ok: true });
  }

  // column-archive / card-unarchive: take a merged column's cards off the
  // board into .line-archive.json, and put one back (see src/lib/archive.ts).
  // The file gaining the card is written first, so a crash between the two
  // writes leaves a duplicate, never a lost card.
  function columnArchive(_ctx: Ctx, { olderThanDays }: z.output<typeof ColumnArchiveBody>, board: Board, columnId: string): Response {
    if (!isLandedColumn(board, columnId)) return json({ ok: false, error: "only a merged column's cards can be archived" }, 400);
    const archive = loadArchiveForWrite(dir);
    if (!archive) return json({ ok: false, error: "the archive file can't be read, so archiving would overwrite it; fix or move .line-archive.json" }, 500);
    const now = Date.now();
    const ids = archivableIds(board, columnId, now, olderThanDays === undefined ? undefined : olderThanDays * 86_400_000);
    if (!ids.length) return json({ ok: true, archived: 0 });
    const next = archiveCards(board, archive, ids, now);
    writeArchive(dir, next.archive);
    writeBoard(dir, next.board);
    push();
    return json({ ok: true, archived: ids.length });
  }

  function cardUnarchive(_ctx: Ctx, { cardId }: z.output<typeof CardRef>): Response {
    const archive = loadArchiveForWrite(dir);
    if (!archive) return json({ ok: false, error: "the archive file can't be read; fix or move .line-archive.json" }, 500);
    const next = restoreArchivedCard(readBoard(dir), archive, cardId);
    if (!next) return json({ ok: false, error: `no archived card: ${cardId}` }, 404);
    writeBoard(dir, next.board);
    writeArchive(dir, next.archive);
    push();
    return json({ ok: true });
  }

  function cardAdd(_ctx: Ctx, { columnId, title, description, kind, repo, repoPath }: z.output<typeof CardAddBody>): Response {
    const board = readBoard(dir);
    if (!board.columns.some((c) => c.id === columnId)) return json({ ok: false, error: `unknown column: ${columnId}` }, 400);
    // One scrum master card per project: asking again hands back the one there
    // is, so a double-click (or a second tab) never makes two orchestrators.
    if (kind === "scrum") {
      const existing = findScrumCard(board, repo);
      if (existing) return json({ ok: true, cardId: existing.id, existing: true });
    }
    let next = addCard(board, columnId, title);
    const card = next.cards[next.cards.length - 1]!; // addCard appends
    if (repo) next = setCardRepo(next, card.id, repo, repoPath);
    if (kind === "scrum") {
      // Top of the column, so it is the first thing in the backlog, not the last.
      next = moveCard(setCardKind(next, card.id, kind), card.id, columnId, 0);
      if (!description.trim()) description = scrumBrief(repo, repoPath);
    }
    if (description.trim()) next = setCardDescription(next, card.id, description);
    writeBoard(dir, next);
    push();
    return json({ ok: true, cardId: card.id });
  }

  function cardDelete(_ctx: Ctx, _body: unknown, card: Card, board: Board): Response {
    writeBoard(dir, deleteCard(board, card.id));
    push();
    return json({ ok: true });
  }

  function commentDelete(_ctx: Ctx, { commentId }: z.output<typeof CommentDeleteBody>, card: Card, board: Board): Response {
    writeBoard(dir, deleteComment(board, card.id, commentId));
    push();
    return json({ ok: true });
  }

  async function cardMove(_ctx: Ctx, body: z.output<typeof CardMoveBody>, card: Card, board: Board, title: string): Promise<Response> {
    const cardId = card.id;
    const to = board.columns.find((c) => c.id === body.toColumnId);
    if (!to) return json({ ok: false, error: `unknown column: ${String(body.toColumnId)}` }, 400);
    const actor = resolveActor(card, body);
    if ("error" in actor) return json({ ok: false, error: actor.error }, actor.status);
    if (!actor.name) actor.name = "someone";
    const fromIndex = board.columns.findIndex((c) => c.id === card.columnId);
    const direction = board.columns.indexOf(to) < fromIndex ? "back" : "forward";
    const next = moveCard(board, cardId, to.id, body.toIndex);
    writeBoard(dir, next);
    push();
    // The column id (not display name): unambiguous, and directly
    // reusable by the recipient in a card-move call of its own.
    const delivery = await notifyCardEvent(next, cardId, actor, `[THE LINE] ${nameForAgents(actor.name)} moved "${title}" to "${to.id}".`, { kind: "move", direction });
    const ended = await endFinishedSession(board, cardId, to.id);
    return json({ ok: true, delivery, ...(ended ? { ended: true } : {}) });
  }

  // card-update: edit a card's own text — its title, its description, its
  // file claim, its repo label. Each field is applied only when present, so renaming a card
  // can't wipe a description written by someone else (and vice versa).
  // Silent by design: text edits don't wake the assignee the way a move
  // or a comment does.
  // CardUpdateBody holds the rules: at least one field, a title that isn't
  // blank, touches as a list of paths/globs ([] clears the claim), and repo
  // as the card's project label ("" or null clears it).
  function cardUpdate(_ctx: Ctx, body: z.output<typeof CardUpdateBody>, card: Card, board: Board): Response {
    const cardId = card.id;
    let next = board;
    if (body.title !== undefined) next = renameCard(next, cardId, body.title);
    if (body.description !== undefined) next = setCardDescription(next, cardId, body.description);
    if (body.touches !== undefined) next = setCardTouches(next, cardId, body.touches);
    if (body.repo !== undefined) next = setCardRepo(next, cardId, body.repo, body.repoPath);
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
  async function cardMerge({ req }: Ctx, body: z.output<typeof CardMergeBody>, card: Card, board: Board, title: string): Promise<Response> {
    const cardId = card.id;
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
    const by = actor.name || HUMAN;
    // Merge order: a card behind an overlapping, unmerged card waits
    // for it. Checked before the queue so a held card never touches git.
    // `force` is the human's override, as on card-assign and spawn.
    const waiting = body.force ? null : mergeBlockReason(board, cardId);
    if (waiting) return json({ ok: false, error: waiting }, 409);
    // `tip` is what the human's preview showed; a branch that moved since
    // is refused inside the queue, so nothing they didn't see can land.
    const r = await mergeWork(where.cwd, { tip: body.tip });
    if (!r.ok) return json(r, 409);
    const note = `Merged ${r.branch} into ${r.base}.`;
    // Landed for real, so the card goes to mergedColumn and its claim is
    // released; each card that was waiting on it is told so on its own
    // card. No await between this read and the write.
    const before = readBoard(dir);
    const landed = landMergedCard(addComment(before, cardId, by, note), cardId);
    const released = mergeReleaseNotes(before, landed, cardId);
    let next = landed;
    for (const n of released) next = addComment(next, n.cardId, MERGE_NOTE_AUTHOR, n.text);
    writeBoard(dir, next);
    push();
    void notifyCardEvent(next, cardId, { ...actor, name: by }, `[THE LINE] ${nameForAgents(by)} merged "${title}" -- ${note}`, { kind: "move", direction: "forward" });
    for (const n of released) {
      const t = next.cards.find((k) => k.id === n.cardId)?.title.trim() || "(untitled card)";
      void notifyCardEvent(next, n.cardId, { name: MERGE_NOTE_AUTHOR }, `[THE LINE] ${MERGE_NOTE_AUTHOR} commented on "${t}":\n${n.text}`, { kind: "comment" });
    }
    // The work has landed, so the agent that did it is finished: end its
    // session rather than leave it idling on a card that's gone. Only a LIVE
    // assignee — one that has already gone has nothing to close. Best-effort:
    // the merge stands either way, and the result rides back so the dashboard
    // can tell a closed tab from one it couldn't find.
    const live = findAssigneeSession(readSnapshot(dir, Date.now()).agents, card.assignee);
    const quitResult = live ? await quit(live) : undefined;
    // And its worktree and branch with it, when the dashboard made them and
    // nothing is left in them (see cleanupMergedWork). Best-effort too: what
    // it keeps is said on the card, and never fails the merge.
    const cleanup = await cleanupMergedWork(where.cwd, r.branch ?? "");
    const tidy = cleanup.removed && cleanup.branchDeleted ? `Removed its worktree and branch ${r.branch}.` : cleanup.why;
    if (tidy) {
      writeBoard(dir, addComment(readBoard(dir), cardId, MERGE_NOTE_AUTHOR, tidy));
      push();
    }
    return json({ ...r, cleanup, ...(quitResult ? { quit: quitResult } : {}) });
  }

  // worktree-cleanup (CONFIG): worktrees merged by hand never went through
  // MERGE, so nothing removed them. The repos are the ones the board and the
  // agents point at; every agent on the desk counts as live, so its worktree
  // stays. A preview is read-only; removing is the human's confirm from the
  // dashboard, as MERGE is.
  async function worktreeCleanup({ req }: Ctx, body: z.output<typeof WorktreeCleanupBody>): Promise<Response> {
    const board = readBoard(dir);
    const agents = readSnapshot(dir, Date.now()).agents;
    const repos = [...board.cards.map((k) => k.repoPath ?? ""), ...agents.map((a) => a.cwd)];
    const live = agents.map((a) => a.cwd);
    if (!body.remove) return json({ ok: true, ...(await planWorktreeCleanup(repos, live)) });
    if (req.headers.get("sec-fetch-site") !== "same-origin") {
      return json({ ok: false, error: "cleaning up worktrees is a human's call — use CONFIG in the dashboard" }, 403);
    }
    return json({ ok: true, ...(await cleanupMergedWorktrees(repos, live, body.remove)) });
  }

  async function cardComment(_ctx: Ctx, body: z.output<typeof CardCommentBody>, card: Card, board: Board, title: string): Promise<Response> {
    const cardId = card.id;
    const actor = resolveActor(card, body);
    if ("error" in actor) return json({ ok: false, error: actor.error }, actor.status);
    const text = body.text;
    // Checked after the signature, so a bad one is what gets reported.
    if (!actor.name || !text) return json({ ok: false, error: "a signature (author, sessionId or as: \"assignee\") and text are required" }, 400);
    const next = addComment(board, cardId, actor.name, text);
    writeBoard(dir, next);
    push();
    const delivery = await notifyCardEvent(next, cardId, actor, `[THE LINE] ${nameForAgents(actor.name)} commented on "${title}":\n${text}`, { kind: "comment" });
    return json({ ok: true, delivery });
  }

  // send-task: compose the full protocol prompt server-side and type it
  // into the assigned live session's terminal. The curl targets in the
  // footer are this very server, taken from the request's own origin.
  async function sendTask({ url }: Ctx, body: z.output<typeof SendTaskBody>, card: Card, board: Board): Promise<Response> {
    const cardId = card.id;
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
    const prompt = cardTaskPrompt(progressed, cardId, url.origin, agent.name, { workedBefore, crew: agent.crew?.id });
    if (!prompt.trim()) return json({ ok: false, error: "card has no task text to send" }, 400);
    // Fresh delivery: clear the agent's context before the new task so
    // the previous ticket doesn't bleed into this one.
    const r = await deliverFresh(agent, prompt);
    if (!r.ok) return json(r, 502); // delivery failed: leave the card where it was
    const by = body.author || "You";
    // Re-read after the await, then apply the move + the send record as one
    // write (moveToWorkColumn is a no-op if it already landed in-progress).
    writeBoard(dir, addComment(moveToWorkColumn(readBoard(dir), cardId), cardId, by, `Sent task to ${agent.name}.`));
    push();
    return json({ ok: true });
  }

  // card-assign: bind a LIVE session (resolved to its display name so
  // the label survives the session ending), or clear with null.
  async function cardAssign(_ctx: Ctx, body: z.output<typeof CardAssignBody>, card: Card, board: Board, title: string): Promise<Response> {
    const cardId = card.id;
    if (body.sessionId === null) {
      pendingSpawns = pendingSpawns.filter((p) => p.cardId !== cardId);
      const next = assignCard(board, cardId, null);
      writeBoard(dir, next);
      push();
      const delivery = await notifyTakenOff(next, card, null, title);
      return json({ ok: true, delivery });
    }
    // The same file-claim gate as spawn: binding an agent to this card is
    // staffing it. Unassigning (handled above) is never blocked — it is
    // how you get OUT of a conflict.
    if (!body.force) {
      const blocked = claimBlockReason(board, cardId);
      if (blocked) return json({ ok: false, error: blocked }, 409);
    }
    const resolved = resolveAssignee(dir, body.sessionId);
    if (!resolved) return json({ ok: false, error: "no session with that id" }, 404);
    pendingSpawns = pendingSpawns.filter((p) => p.cardId !== cardId);
    const next = assignCard(board, cardId, resolved);
    writeBoard(dir, next);
    push();
    const delivery = await notifyTakenOff(next, card, resolved, title);
    return json({ ok: true, delivery });
  }

  // The agent a card-assign took off the card is told to stop, or it carries
  // on from its footer. The scrum master hears it as FYI. Nobody is told when
  // the card had no assignee, or the "new" one is the same agent (by crew, as
  // everywhere, so a /clear's new session id is not a change of hands).
  async function notifyTakenOff(next: Board, before: Card, to: NonNullable<Card["assignee"]> | null, title: string): Promise<Delivery[]> {
    const was = before.assignee;
    if (!was) return [];
    if (to && (was.crew && to.crew ? was.crew === to.crew : was.id === to.id)) return [];
    const { agents } = readSnapshot(dir, Date.now());
    const old = findAssigneeSession(agents, was);
    const card = next.cards.find((k) => k.id === before.id) ?? before;
    const where = `"${title}" (${before.id})`;
    const out: Delivery[] = [];
    if (old) {
      out.push(await deliverTo(old, `[THE LINE] You were taken off ${where}. Stop work on it and do not write to it again.\n(no reply needed)`));
    }
    const change = to ? `reassigned from ${nameForAgents(was.name)} to ${nameForAgents(to.name)}` : `unassigned from ${nameForAgents(was.name)}`;
    for (const a of agents) {
      if (a === old || a.persona !== "scrum-master" || !scrumHears(next, a, card)) continue;
      out.push(await deliverTo(a, `[THE LINE] ${where} was ${change}.\n(FYI, no reply needed unless it raises a problem or asks you something)`));
    }
    return out;
  }

  // upload: save an image dropped/pasted into a chat to a temp file, and
  // return its path. Not tied to a session — the path is later prepended to
  // a prompt and typed into the terminal, where Claude Code reads it.
  function upload(_ctx: Ctx, { name, type, dataBase64 }: z.output<typeof UploadBody>): Response {
    const r = saveUpload(name, type, dataBase64);
    return json(r, r.ok ? 200 : 400);
  }

  // crew-note: a crew member keeping its notes (see src/lib/crew.ts),
  // signed like a card write: by crew id (the SessionStart context hands
  // the agent its own), by session id, or as a card's assignee.
  function crewNote(_ctx: Ctx, body: z.output<typeof CrewNoteBody>): Response {
    const crewId = resolveCrewId(body);
    if ("error" in crewId) return json({ ok: false, error: crewId.error }, crewId.status);
    const r = addNote(dir, crewId.id, body.text, { replace: body.replace });
    return json(r, r.ok ? 200 : 400);
  }

  // ---- memory-*: the team memory (src/lib/memory.ts) ---------------------------
  // Read, change and write with no await between, so two writers can't
  // interleave; compacted on every write so the file stays small. A memory
  // file that is there but unreadable is refused, never overwritten.

  const MEMORY_UNREADABLE = "the memory file can't be read, so writing would overwrite it; fix or move .line-memory.json";

  function memoryAdd(_ctx: Ctx, body: z.output<typeof MemoryAddBody>): Response {
    const memory = loadMemoryForWrite(dir);
    if (!memory) return json({ ok: false, error: MEMORY_UNREADABLE }, 500);
    const now = Date.now();
    let r: ReturnType<typeof remember>;
    try {
      r = remember(memory, { kind: body.kind as FactKind, title: body.title, body: body.body, tags: body.tags, links: body.links, by: body.author || undefined }, now);
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
    writeMemory(dir, compactMemory(r.memory, now));
    return json({ ok: true, node: r.node });
  }

  function memoryForget(_ctx: Ctx, { id }: z.output<typeof MemoryForgetBody>): Response {
    const memory = loadMemoryForWrite(dir);
    if (!memory) return json({ ok: false, error: MEMORY_UNREADABLE }, 500);
    const next = forget(memory, id);
    if (!next) return json({ ok: false, error: `no memory: ${id}` }, 404);
    writeMemory(dir, compactMemory(next, Date.now()));
    return json({ ok: true });
  }

  // ---- mood-*: the MOOD board (src/lib/mood.ts) -------------------------------
  // The same discipline as card-*: each action names the one note or link it
  // changes and applies it to a fresh read, so the human dragging a note and
  // an agent adding one compose instead of clobbering each other.

  /** mood-note-update/-delete: the note must exist on a fresh read. */
  const withMoodNote = <S extends z.ZodType>(schema: S, fn: (ctx: Ctx, body: z.output<S>, mood: Mood, noteId: string) => Result) =>
    withBody(MoodNoteRef, (ctx, { noteId }) => {
      const mood = readMood(dir);
      if (!mood.notes.some((n) => n.id === noteId)) return json({ ok: false, error: `unknown note: ${noteId}` }, 404);
      return withBody(schema, (ctx, body) => fn(ctx, body, mood, noteId))(ctx);
    });
  /** mood-link-update/-delete: the link must exist on a fresh read. */
  const withMoodLink = <S extends z.ZodType>(schema: S, fn: (ctx: Ctx, body: z.output<S>, mood: Mood, linkId: string) => Result) =>
    withBody(MoodLinkRef, (ctx, { linkId }) => {
      const mood = readMood(dir);
      if (!mood.links.some((l) => l.id === linkId)) return json({ ok: false, error: `unknown link: ${linkId}` }, 404);
      return withBody(schema, (ctx, body) => fn(ctx, body, mood, linkId))(ctx);
    });

  function moodNoteAdd(_ctx: Ctx, body: z.output<typeof MoodNoteAddBody>): Response {
    const { mood, id } = addMoodNote(readMood(dir), {
      title: body.title, x: body.x, y: body.y, kind: body.kind, body: body.body, w: body.w,
      cardId: body.cardId, by: body.author || undefined,
    });
    writeMood(dir, mood);
    return json({ ok: true, noteId: id });
  }

  function moodNoteUpdate(_ctx: Ctx, body: z.output<typeof MoodNoteUpdateBody>, mood: Mood, noteId: string): Response {
    const { raise, ...fields } = body;
    let next = updateNote(mood, noteId, fields as NotePatch);
    if (raise) next = raiseNote(next, noteId);
    writeMood(dir, next);
    return json({ ok: true });
  }

  function moodNoteDelete(_ctx: Ctx, _body: unknown, mood: Mood, noteId: string): Response {
    writeMood(dir, deleteNote(mood, noteId));
    return json({ ok: true });
  }

  function moodNoteRestore(_ctx: Ctx, { note, links }: z.output<typeof MoodNoteRestoreBody>): Response {
    writeMood(dir, restoreNote(readMood(dir), note, links as MoodLink[]));
    return json({ ok: true, noteId: note.id });
  }

  function moodLinkAdd(_ctx: Ctx, { from, to, label }: z.output<typeof MoodLinkAddBody>): Response {
    const mood = readMood(dir);
    const blocked = linkBlockReason(mood, from, to);
    if (blocked) return json({ ok: false, error: blocked }, 400);
    const r = addLink(mood, from, to, label);
    writeMood(dir, r.mood);
    return json({ ok: true, linkId: r.id });
  }

  function moodLinkUpdate(_ctx: Ctx, { label }: z.output<typeof MoodLinkUpdateBody>, mood: Mood, linkId: string): Response {
    writeMood(dir, setLinkLabel(mood, linkId, label));
    return json({ ok: true });
  }

  function moodLinkDelete(_ctx: Ctx, _body: unknown, mood: Mood, linkId: string): Response {
    writeMood(dir, deleteLink(mood, linkId));
    return json({ ok: true });
  }

  // inbox-drain: a session's Stop hook collecting the board events that
  // arrived while it was busy. Hands them over once; the hook feeds them
  // back to the agent as the reason its turn should continue.
  function inboxDrain(_ctx: Ctx, _body: unknown, sessionId: string): Response {
    const items = drain(sessionId);
    if (items.length) push();
    return json({ ok: true, items });
  }

  // A rename or a new look is stored against the crew member when the
  // session has one, so it survives the /clear that ends this session id.
  const overrideKey = (sessionId: string) => loadStatus(dir, sessionId)?.crew?.id ?? sessionId;

  function renameSession(_ctx: Ctx, body: z.output<typeof RenameBody>, sessionId: string): Response {
    setNameOverride(dir, overrideKey(sessionId), body.name ?? null);
    push();
    return json({ ok: true });
  }

  function setSprite(_ctx: Ctx, { palette, gear, body }: z.output<typeof SpriteBody>, sessionId: string): Response {
    setSpriteOverride(dir, overrideKey(sessionId), { palette, gear, body });
    push();
    return json({ ok: true });
  }

  async function promptSession(_ctx: Ctx, { text }: z.output<typeof PromptBody>, status: AgentStatus): Promise<Response> {
    return json(await sendPrompt(status, text));
  }

  // Anything else. Answers after the same session checks the terminal
  // actions run, so a bad or unknown session id reads as it always has.
  const unknownAction = withSessionStatus(NoFields, () => json({ ok: false, error: "unknown action" }, 404));

  // Each entry names the schema its body is read with (src/lib/actionBodies.ts).
  const actionHandlers: Record<string, ActionHandler<unknown>> = {
    "pick-folder": withBody(PickFolderBody, pickFolder),
    "spawn": withBody(SpawnBody, spawnSession),
    "column-add": withBody(ColumnAddBody, columnAdd),
    "column-update": withColumn(ColumnUpdateBody, columnUpdate),
    "column-delete": withColumn(NoFields, columnDelete),
    "column-reorder": withColumn(ColumnReorderBody, columnReorder),
    "column-restore": withBody(ColumnRestoreBody, columnRestore),
    "card-restore": withBody(CardRestoreBody, cardRestore),
    "column-archive": withColumn(ColumnArchiveBody, columnArchive),
    "card-unarchive": withBody(CardRef, cardUnarchive),
    "card-add": withBody(CardAddBody, cardAdd),
    "card-delete": withCard(NoFields, cardDelete),
    "comment-delete": withCard(CommentDeleteBody, commentDelete),
    "card-move": withCard(CardMoveBody, cardMove),
    "card-update": withCard(CardUpdateBody, cardUpdate),
    "card-merge": withCard(CardMergeBody, cardMerge),
    "card-comment": withCard(CardCommentBody, cardComment),
    "send-task": withCard(SendTaskBody, sendTask),
    "card-assign": withCard(CardAssignBody, cardAssign),
    "upload": withBody(UploadBody, upload),
    "worktree-cleanup": withBody(WorktreeCleanupBody, worktreeCleanup),
    "crew-note": withBody(CrewNoteBody, crewNote),
    "memory-add": withBody(MemoryAddBody, memoryAdd),
    "memory-forget": withBody(MemoryForgetBody, memoryForget),
    "mood-note-add": withBody(MoodNoteAddBody, moodNoteAdd),
    "mood-note-update": withMoodNote(MoodNoteUpdateBody, moodNoteUpdate),
    "mood-note-delete": withMoodNote(NoFields, moodNoteDelete),
    "mood-note-restore": withBody(MoodNoteRestoreBody, moodNoteRestore),
    "mood-link-add": withBody(MoodLinkAddBody, moodLinkAdd),
    "mood-link-update": withMoodLink(MoodLinkUpdateBody, moodLinkUpdate),
    "mood-link-delete": withMoodLink(NoFields, moodLinkDelete),
    "inbox-drain": withSessionId(NoFields, inboxDrain),
    "rename": withSessionId(RenameBody, renameSession),
    "sprite": withSessionId(SpriteBody, setSprite),
    "focus": withSessionStatus(NoFields, async (_ctx, _body, status) => json(await focusSession(status))),
    "pause": withSessionStatus(NoFields, async (_ctx, _body, status) => json(await interruptSession(status))),
    "kill": withSessionStatus(NoFields, async (_ctx, _body, status) => json(await killAgent(status))),
    "prompt": withSessionStatus(PromptBody, promptSession),
  };

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
        let beat: ReturnType<typeof setInterval> | null = null;
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            // Each window is sent the board only when it differs from the
            // last one it got (see snapshotEvent): a busy agent pushes often,
            // and resending a large board every time cost ~1 MB per 15s.
            let sent: Sent = {};
            send = (s) => {
              const out = snapshotEvent(s, sent);
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(out.event)}\n\n`));
              sent = out.sent;
            };
            addClient(send);
            send(snapshot()); // initial
            // Bun closes a connection after 10s with nothing sent, and this
            // stream only speaks when the board changes: a quiet board lost
            // it every ~10s and the header flashed RECONNECTING at a healthy
            // server. A comment line (ignored by EventSource) keeps it open.
            beat = setInterval(() => {
              try { ctrl.enqueue(enc.encode(": ping\n\n")); } catch { if (beat) clearInterval(beat); }
            }, heartbeatMs);
          },
          cancel() { if (beat) clearInterval(beat); dropClient(send); },
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

      // the archived cards, newest first: what the board's ARCHIVED (n) link opens.
      if (url.pathname === "/archive") {
        const board = readBoard(dir);
        return json({ cards: visibleArchive(board, readArchive(dir)) });
      }

      // the team memory: recorded facts plus every card, searched by keyword
      // and filter (see searchMemory). `?id=` is one node and its neighbours;
      // `?format=text` is the digest the MCP memory tools return.
      if (url.pathname === "/memory") {
        const now = Date.now();
        const view = memoryView(readMemory(dir), readBoard(dir), readArchive(dir), now);
        const id = url.searchParams.get("id");
        if (id !== null) {
          const node = view.find((n) => n.id === id);
          if (!node) return json({ error: `no memory: ${id}` }, 404);
          const near = neighbours(view, id);
          if (url.searchParams.get("format") === "text") return new Response(formatResults([node, ...near]), { headers: { "content-type": "text/plain; charset=utf-8" } });
          return json({ node, neighbours: near });
        }
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 20));
        const results = searchMemory(view, url.searchParams.get("q") ?? "", { limit, now });
        if (url.searchParams.get("format") === "text") return new Response(formatResults(results), { headers: { "content-type": "text/plain; charset=utf-8" } });
        return json({ results });
      }

      // one card + the column list — what a worker re-reads its ticket with
      // (the task footer points here), a few KB instead of the whole board.
      if (url.pathname === "/card") {
        const id = url.searchParams.get("id") ?? "";
        const view = cardView(readBoard(dir), id);
        return view ? json(view) : json({ error: `unknown card: ${id}` }, 404);
      }

      // the MOOD board + where it lives; `?format=text` is the agent-readable
      // summary the MCP mood_read tool returns.
      if (url.pathname === "/mood") {
        const mood = readMood(dir);
        if (url.searchParams.get("format") === "text") return new Response(formatMood(mood), { headers: { "content-type": "text/plain; charset=utf-8" } });
        return json({ mood, moodPath: moodFile(dir) });
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
        // id/name/role/skills/model only — the prompt body is never sent to the browser
        return json(loadPersonas().map(({ id, name, role, skills, model }) => ({ id, name, role, skills, ...(model ? { model } : {}) })));
      }

      // whether a card's work is committed and can be landed on the trunk —
      // what puts the MERGE key on the card (and what greys it out). A card
      // waiting behind an overlapping, unmerged card is held here too, with
      // the card to merge first named (see mergeBlockers in lib/board).
      if (url.pathname === "/merge-state") {
        const cardId = url.searchParams.get("cardId") ?? "";
        const where = cardWorkDir(cardId);
        if ("error" in where) return json({ error: where.error }, where.status);
        const board = readBoard(dir);
        // A merged card's worktree was removed after it landed: that is the
        // answer, not "not a git repository".
        const card = board.cards.find((k) => k.id === cardId);
        if (card && !existsSync(where.cwd) && isLandedColumn(board, card.columnId)) {
          return json(holdForClaims({ ...(await readMergeState("")), blocked: "already merged" }, board, cardId));
        }
        const state = await readMergeState(where.cwd);
        return json(holdForClaims(state, board, cardId));
      }

      // what a MERGE would land: the branch's commits and changed files,
      // capped, for the card to show above its key. Read-only.
      if (url.pathname === "/merge-preview") {
        const where = cardWorkDir(url.searchParams.get("cardId") ?? "");
        if ("error" in where) return json({ error: where.error }, where.status);
        return json(await readMergePreview(where.cwd));
      }

      // a session's git context (branch, commits, working-tree status)
      if (url.pathname === "/repo") {
        const sid = url.searchParams.get("sessionId") ?? "";
        if (!validSessionId(sid)) return json({ error: "bad sessionId" }, 400);
        const status = loadStatus(dir, sid);
        if (!status) return json({ error: "unknown session" }, 404);
        return json(await readRepo(status.cwd));
      }

      // commands: act on a real session. dispatchAction applies the CSRF gate
      // before it looks up any handler (see actionHandlers above).
      if (req.method === "POST" && url.pathname.startsWith("/action/")) {
        return dispatchAction(req, actionHandlers, unknownAction);
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
      const file = Bun.file(join(distDir, path));
      if (await file.exists()) return new Response(file);
      // dist/ isn't tracked, so a fresh worktree's `bun run dev` serves before
      // anything is built. Say so, rather than a bare "not found" that reads
      // as a broken route.
      if (path === "/index.html") return new Response(UNBUILT_PAGE, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
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
  const leak = sandboxLeakWarning(process.env, homedir());
  if (leak) console.warn(leak);
  const server = makeServer(Number(process.env.PORT ?? 4173), { scan: true });
  console.log(`Agent Workshop → http://localhost:${server.port}  (watching ${statusDir()}, scanning open sessions)`);
}
