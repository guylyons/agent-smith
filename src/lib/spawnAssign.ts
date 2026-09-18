// src/lib/spawnAssign.ts — binding a card to the session spawned for it,
// without relying on hooks.
//
// "New agent for this card" can't set the assignee at launch: the session id
// is minted inside the new terminal. With hooks installed, the SessionStart
// hook self-assigns from AGENT_CARD. Without hooks nothing reads that env var,
// so the server records the intent at /action/spawn and applies it when the
// new session first shows up in the snapshot.
//
// The match must be something the spawn controls, never a guess:
//   - the crew id the server minted (present when hooks run), or
//   - the fresh worktree the spawn created (a cwd nobody else can be in yet),
//     when exactly one new session is there, or
//   - in a shared folder, a new session there whose opening prompt is the
//     task the spawn typed.
// Anything ambiguous waits for the next pass; an intent nobody picks up
// expires.

import type { AgentStatus } from "../schema";

export type PendingSpawn = {
  cardId: string;
  /** Where the session was launched. */
  cwd: string;
  /** True when the spawn created `cwd` (a fresh worktree), so any new session
   *  in it is ours. False for a launch into an existing folder. */
  uniqueCwd: boolean;
  /** The crew id minted for the launch; a hooked session reports it. */
  crewId?: string;
  /** The opening prompt the launch typed. */
  task: string;
  /** Session ids already live at spawn time: never ours. */
  before: string[];
  /** When the spawn happened (Unix ms). */
  at: number;
  /** The spawn was forced past the file-claim gate. */
  force: boolean;
};

/** Long enough for a slow first scan; short enough that a session started by
 *  hand in the same folder much later is never taken for the spawn. */
export const PENDING_SPAWN_TTL_MS = 10 * 60_000;

export type SpawnMatch = { spawn: PendingSpawn; sessionId: string };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** New sessions in the spawn's folder that could be its session: not live at
 *  spawn time, and not carrying some other crew's id. */
function candidates(p: PendingSpawn, agents: AgentStatus[]): AgentStatus[] {
  return agents.filter((a) =>
    a.cwd === p.cwd && !p.before.includes(a.sessionId) && (!a.crew || a.crew.id === p.crewId));
}

/** The sessions whose opening prompt the caller must read before
 *  matchPendingSpawns can decide: new sessions in a shared folder. */
export function sessionsNeedingOpeningPrompt(pending: PendingSpawn[], agents: AgentStatus[]): string[] {
  const ids = new Set<string>();
  for (const p of pending) {
    if (p.uniqueCwd) continue;
    for (const a of candidates(p, agents)) if (!a.crew) ids.add(a.sessionId);
  }
  return [...ids];
}

/** Pair each pending spawn with its session, if it has shown up. Pure.
 *  `opening` maps a session id to its first user prompt (see
 *  sessionsNeedingOpeningPrompt). Returns the matches and the intents still
 *  waiting; expired intents are in neither. */
export function matchPendingSpawns(
  pending: PendingSpawn[],
  agents: AgentStatus[],
  now: number,
  opening: Map<string, string> = new Map(),
): { matches: SpawnMatch[]; keep: PendingSpawn[] } {
  const live = pending.filter((p) => now - p.at <= PENDING_SPAWN_TTL_MS);
  const matches: SpawnMatch[] = [];
  const taken = new Set<string>();
  const done = new Set<PendingSpawn>();

  // First, the definitive match: the crew id the spawn minted.
  for (const p of live) {
    if (!p.crewId) continue;
    const a = agents.find((x) => x.crew?.id === p.crewId && !p.before.includes(x.sessionId));
    if (a && !taken.has(a.sessionId)) { matches.push({ spawn: p, sessionId: a.sessionId }); taken.add(a.sessionId); done.add(p); }
  }

  // Then by folder, for sessions without a crew (no hooks). A folder more
  // than one waiting spawn points at is ambiguous, whatever is in it.
  const open = live.filter((p) => !done.has(p));
  for (const p of open) {
    if (open.some((q) => q !== p && q.cwd === p.cwd)) continue;
    let cands = candidates(p, agents).filter((a) => !a.crew && !taken.has(a.sessionId));
    if (!p.uniqueCwd) cands = cands.filter((a) => norm(opening.get(a.sessionId) ?? "") === norm(p.task));
    if (cands.length !== 1) continue;
    matches.push({ spawn: p, sessionId: cands[0]!.sessionId });
    taken.add(cands[0]!.sessionId);
    done.add(p);
  }

  return { matches, keep: live.filter((p) => !done.has(p)) };
}
