import type { AgentStatus } from "../schema";

// Compact "how long it's been in this state": <1m, 12m, 3h, 2d. Empty when the
// hook/scanner hasn't stamped stateSince yet (old status file).
export function inStateFor(stateSince: number | undefined, now: number): string {
  if (!stateSince) return "";
  const m = Math.floor((now - stateSince) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Dim an agent that's been idle this long — still present, visibly dormant.
export const STALE_IDLE_MS = 30 * 60_000;

/** Idle for longer than STALE_IDLE_MS. False without a stateSince stamp. */
export function isStaleIdle(a: Pick<AgentStatus, "state" | "stateSince">, now: number): boolean {
  return a.state === "idle" && !!a.stateSince && now - a.stateSince > STALE_IDLE_MS;
}
