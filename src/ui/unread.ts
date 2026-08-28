import type { AgentStatus } from "../schema";

// Which agents have something for the human to READ, so their desk on the grid
// can carry a "!" bubble until it's opened. The alert centre already tells you
// an agent finished or needs you, but an alert scrolls away — the badge is what
// makes the grid itself say "this one is waiting on your eyes".
//
// Pure: the caller owns the previous states and the read-set. Same discipline as
// soundEvents.ts, and for the same reason — it's the transition that matters,
// never the standing state.

/** Per-agent state carried between snapshots, keyed by session id. */
export type PrevStates = Map<string, AgentStatus["state"]>;

export type UnreadDiff = { ids: string[]; next: PrevStates };

/**
 * Diff the previous per-agent states against the current agents and return the
 * sessions that just produced something to read:
 *
 *   - `working` → `idle`     the agent finished and signed off with a message
 *   - anything  → `waiting`  it stopped to ask you something
 *
 * `primed` guards the first populated snapshot: on the baseline we record states
 * without flagging anyone, so a page reload doesn't badge every desk that
 * happens to be sitting idle. Completion additionally requires a prior
 * `working`, so an agent first seen idle is not treated as freshly finished.
 */
export function diffUnread(prev: PrevStates, agents: AgentStatus[], primed: boolean): UnreadDiff {
  const next: PrevStates = new Map();
  const ids: string[] = [];
  for (const a of agents) {
    const was = prev.get(a.sessionId);
    next.set(a.sessionId, a.state);
    if (!primed || a.state === was) continue;
    if (a.state === "waiting") ids.push(a.sessionId);
    else if (a.state === "idle" && was === "working") ids.push(a.sessionId);
  }
  return { ids, next };
}

const LS_KEY = "aw-unread-agents";

export function loadUnread(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as string[]); }
  catch { return new Set(); }
}

/** Persist the unread set, dropping ids for sessions that are no longer live so
 *  the store can't grow without bound as agents come and go. */
export function saveUnread(ids: Set<string>, agents: AgentStatus[]): void {
  const live = new Set(agents.map((a) => a.sessionId));
  try { localStorage.setItem(LS_KEY, JSON.stringify([...ids].filter((id) => live.has(id)))); }
  catch { /* storage unavailable — the badge just won't survive a reload */ }
}
