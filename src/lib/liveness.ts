import type { AgentStatus } from "../schema";

// Is a status still worth believing?
//
// A status file says "working" until something tells it otherwise, and the two
// things that can are the session's own hooks and the transcript scan. Both go
// quiet when a session dies badly — killed, crashed, the window closed, or a
// Stop that got blocked to drain the board inbox and never came back — and the
// file is left frozen mid-turn. buildSnapshot keeps such a session on the board
// for a further five minutes (staleMs), so "working" outlives the work.
//
// That is invisible on a crew desk, which prints the state and how long it has
// been in it. It is not invisible on a board card, where the assignee's sprite
// bobbing IS the whole signal: an agent that stopped five minutes ago goes on
// looking busy. So anything reading a status as motion asks here first.
//
// Pure — the caller supplies the clock, the same discipline as idle.ts.

/**
 * How long a "working" stamp may go unrefreshed before we stop believing it.
 *
 * The server rescans every open session every 20s and restamps `updatedAt`, and
 * hooks restamp far more often than that in between (measured on a live box:
 * every 2-9s while a turn is running). Four scan passes of headroom means a
 * genuinely-working agent cannot fall out of the window, while a dead one stops
 * claiming to work well inside the five minutes it takes to leave the board.
 */
export const WORKING_FRESH_MS = 90_000;

/** The fields a liveness call actually reads — so a caller can ask about a
 *  status-shaped object without owning a whole AgentStatus. */
type Liveness = Pick<AgentStatus, "state" | "waitingReason" | "updatedAt">;

/**
 * True only when this agent is working AND something restamped it recently
 * enough to vouch for that.
 *
 * A pinned `waitingReason` also disqualifies it: a session blocked on a
 * permission prompt sits on an unresolved tool_use, which the scanner re-derives
 * as "working" (see mergeForWrite in src/scan.ts). mergeForWrite already refuses
 * to let that overwrite the hook's pin, but a status that carries both is a
 * session waiting on the human, not one doing anything.
 */
export function isActivelyWorking(a: Liveness, now: number, freshMs: number = WORKING_FRESH_MS): boolean {
  if (a.state !== "working") return false;
  if (a.waitingReason) return false;
  // No usable stamp means nothing vouches for the state — don't animate on it.
  if (typeof a.updatedAt !== "number" || !Number.isFinite(a.updatedAt)) return false;
  // A stamp from the near future is clock skew between the hook and the server,
  // not staleness; that direction is never a reason to disbelieve it.
  return now - a.updatedAt <= freshMs;
}

/**
 * The state to SHOW for this agent: a "working" nothing has refreshed lately
 * reads as idle, which is what it is. Every other state is reported as-is —
 * `waiting` is set deliberately by a hook and never goes stale in this sense.
 */
export function displayState(a: Liveness, now: number, freshMs: number = WORKING_FRESH_MS): AgentStatus["state"] {
  if (a.state !== "working") return a.state;
  return isActivelyWorking(a, now, freshMs) ? "working" : "idle";
}
