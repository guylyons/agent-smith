// A crew member: the identity that outlives a session. Claude Code mints a new
// session id on every /clear, and the dashboard clears a session before handing
// it a new card — so anything keyed to the session id (its codename, the card
// assigned to it, the notes it was keeping) used to reset with the context.
// The anchor here is a crew id + name minted by the dashboard at spawn and
// carried in the launch env (AGENT_CREW / AGENT_NAME), which the claude
// process keeps across /clear, so every hook in every later session sees the
// same crew. A session started by hand has no env; its anchor is the claude
// pid, which is just as stable across /clear.
//
// Names come from the Alien films: a random unused one per spawn, so the crew
// reads as people rather than as a persona repeated four times.
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { AgentStatus } from "../schema";
import type { Assignee, Board, Card } from "./board";

/** Crew of the Nostromo, Sulaco, Auriga, Prometheus, Covenant, Corbelan and
 *  Maginot, with the odd ship and synthetic. Uppercase ASCII: the name rides
 *  into a session through the pty, which mangles anything else. */
export const ROSTER: readonly string[] = [
  // Alien
  "RIPLEY", "DALLAS", "KANE", "LAMBERT", "PARKER", "BRETT", "ASH", "JONESY", "NOSTROMO",
  // Aliens
  "HICKS", "HUDSON", "VASQUEZ", "APONE", "GORMAN", "BISHOP", "BURKE", "NEWT", "DRAKE",
  "FROST", "FERRO", "SPUNKMEYER", "DIETRICH", "WIERZBOWSKI", "CROWE", "SULACO",
  // Alien 3
  "CLEMENS", "DILLON", "ANDREWS", "GOLIC", "MORSE", "AARON",
  // Alien Resurrection
  "CALL", "VRIESS", "JOHNER", "CHRISTIE", "ELGYN", "HILLARD", "WREN", "GEDIMAN", "DISTEPHANO", "AURIGA",
  // Prometheus
  "SHAW", "HOLLOWAY", "DAVID", "VICKERS", "JANEK", "FIFIELD", "MILLBURN", "CHANCE", "RAVEL",
  // Alien: Covenant
  "DANIELS", "ORAM", "TENNESSEE", "WALTER", "LOPE", "KARINE", "FARIS", "ANKOR", "LEDWARD", "HALLETT", "COLE", "ROSENTHAL", "COVENANT",
  // Alien: Romulus
  "RAIN", "ANDY", "TYLER", "KAY", "BJORN", "NAVARRO", "ROOK", "CORBELAN",
  // Alien: Earth
  "WENDY", "KIRSH", "HERMIT", "SLIGHTLY", "NIBS", "CURLY", "SMEE", "MORROW", "KAVALIER", "MAGINOT",
];

/** Mirrored as CREW_ID in src/lib/board.ts, which the browser bundle imports. */
export const CREW_ID_RE = /^[a-z0-9-]{1,64}$/;

export type Crew = { id: string; name: string };

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A deterministic roster name for an anchor with no minted name (a session
 *  started by hand, keyed by its pid; a hookless session, keyed by its id). */
export function rosterName(anchor: string): string {
  return ROSTER[hash(anchor) % ROSTER.length]!;
}

/** A random roster name not in `taken`. When every name is live, any name —
 *  the snapshot's uniquifier suffixes the collision rather than refusing a
 *  launch. `rand` is injectable so the pick is testable. */
export function pickName(taken: Iterable<string>, rand: () => number = Math.random): string {
  const used = new Set(Array.from(taken, (n) => n.toUpperCase()));
  const free = ROSTER.filter((n) => !used.has(n));
  const pool = free.length ? free : ROSTER;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]!;
}

/** The name for an agent spawned into a persona with a fixed name: the name
 *  itself while no live desk wears it, else the first free NAME-2, NAME-3...
 *  so two copies of one role never sign board comments as the same person. */
export function castName(base: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (n) => n.toUpperCase()));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** A crew id: the name plus four hex chars, so two RIPLEYs over the life of
 *  the board (one ends, another spawns) keep separate notes. */
export function mintCrewId(name: string, rand: () => number = Math.random): string {
  const tag = Math.floor(rand() * 0x10000).toString(16).padStart(4, "0");
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tag}`;
}

/** The crew a session should carry, from the launch env when the dashboard
 *  minted one (both halves must be present and well-formed), else from the
 *  claude pid, else none. Pure; the hook feeds it the real env and pid. */
export function crewFrom(env: { AGENT_CREW?: string; AGENT_NAME?: string }, pid?: number): Crew | undefined {
  const id = env.AGENT_CREW?.trim() ?? "";
  const name = env.AGENT_NAME?.trim() ?? "";
  if (id && name && CREW_ID_RE.test(id) && /^[A-Za-z0-9 ._-]{1,32}$/.test(name)) return { id, name };
  if (pid && pid > 0) return { id: `pid-${pid}`, name: rosterName(`pid:${pid}`) };
  return undefined;
}

/** Show each agent under its crew name. Pure. Sits between personas and user
 *  overrides in the snapshot: override > crew > persona name > hashed. */
export function applyCrew(agents: AgentStatus[]): AgentStatus[] {
  return agents.map((a) => (a.crew ? { ...a, name: a.crew.name } : a));
}

/** Is this live session the card's assignee? By crew when the card knows one
 *  (the session id changes on every /clear; the crew does not), else by id. */
export function isAssigneeSession(assignee: Assignee | null | undefined, agent: Pick<AgentStatus, "sessionId" | "crew">): boolean {
  if (!assignee) return false;
  if (assignee.crew && agent.crew?.id === assignee.crew) return true;
  return agent.sessionId === assignee.id;
}

export function findAssigneeSession<A extends Pick<AgentStatus, "sessionId" | "crew">>(agents: A[], assignee: Assignee | null | undefined): A | undefined {
  return agents.find((a) => isAssigneeSession(assignee, a));
}

/** Is this live session the one that did a board write? By crew or session id
 *  when the signature carried one. A bare name also matches that name with the
 *  session-id fragment the snapshot adds when two desks share a name, so a
 *  signer writing "DALLAS" is still DALLAS when its desk shows "DALLAS d8c1". */
export function isActorSession(
  actor: { name: string; sessionId?: string; crew?: string },
  agent: Pick<AgentStatus, "sessionId" | "crew" | "name">,
): boolean {
  if (actor.crew && agent.crew?.id === actor.crew) return true;
  if (actor.sessionId) return agent.sessionId === actor.sessionId;
  if (actor.crew || !actor.name) return false;
  return agent.name === actor.name || agent.name === `${actor.name} ${agent.sessionId.slice(0, 4)}`;
}

/** Should this scrum master hear about an event on this card? Only when the
 *  card is in its project: the repo of the scrum card it is assigned to. A card
 *  with no repo, or a scrum master with no project on record, hears all. */
export function scrumHears(board: Board, agent: Pick<AgentStatus, "sessionId" | "crew">, card: Card): boolean {
  const cardRepo = (card.repo ?? "").trim();
  if (!cardRepo) return true;
  const own = board.cards.find((k) => k.kind === "scrum" && isAssigneeSession(k.assignee, agent));
  const ownRepo = (own?.repo ?? "").trim();
  return !ownRepo || ownRepo === cardRepo;
}

// ---- notes ------------------------------------------------------------------
// One small markdown file per crew member, next to the status files. The
// SessionStart hook hands it to the agent as context, so what a crew member
// wrote down survives /clear for a few hundred tokens rather than a whole
// transcript. Capped so it stays that cheap.

export const NOTES_CAP = 2000;

export function notesDir(dir: string): string {
  return join(dir, "crew");
}

function notesFile(dir: string, crewId: string): string {
  return join(notesDir(dir), `${crewId}.md`);
}

/** A crew member's notes, "" when there are none (or the id is malformed). */
export function readNotes(dir: string, crewId: string): string {
  if (!CREW_ID_RE.test(crewId)) return "";
  try { return readFileSync(notesFile(dir, crewId), "utf8"); } catch { return ""; }
}

function writeNotes(dir: string, crewId: string, text: string): void {
  mkdirSync(notesDir(dir), { recursive: true });
  const file = notesFile(dir, crewId);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export type NoteResult = { ok: true; notes: string } | { ok: false; error: string };

/** Add a note (one more line) or replace the whole file. Refuses a result over
 *  the cap and says so, so the agent rewrites shorter instead of the file
 *  silently growing into the context cost this exists to avoid. */
export function addNote(dir: string, crewId: string, text: string, opts: { replace?: boolean } = {}): NoteResult {
  if (!CREW_ID_RE.test(crewId)) return { ok: false, error: "bad crew id" };
  const line = text.trim();
  if (!line && !opts.replace) return { ok: false, error: "note text is required" };
  const prev = opts.replace ? "" : readNotes(dir, crewId).trimEnd();
  const next = [prev, line].filter(Boolean).join("\n") + (line || prev ? "\n" : "");
  if (next.length > NOTES_CAP) {
    return { ok: false, error: `notes would be ${next.length} chars; the cap is ${NOTES_CAP}. Rewrite them shorter with replace: true.` };
  }
  writeNotes(dir, crewId, next);
  return { ok: true, notes: next };
}

/** What the SessionStart hook hands a crew member: who it is, its notes, and
 *  the exact call to keep them current. Pure ASCII (see ROSTER). */
export function notesContext(crew: Crew, notes: string, serverUrl: string): string {
  const body = notes.trim() || "(none yet)";
  return [
    `[THE LINE] You are ${crew.name} (crew id ${crew.id}). Your name and this crew id`,
    "stay with you across /clear. Your notes from earlier sessions:",
    "",
    body,
    "",
    "Keep these notes current for your future self: decisions, gotchas, where",
    `things live. Short lines, ${NOTES_CAP} chars in all. Add a line:`,
    `  curl -s -X POST ${serverUrl}/action/crew-note -H 'content-type: application/json' -d '{"crew":"${crew.id}","text":"<note>"}'`,
    'Rewrite them all: the same call with "replace":true. If you have the-line',
    "MCP tools, crew_note does the same.",
  ].join("\n");
}
