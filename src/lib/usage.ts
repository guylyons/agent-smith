// Fleet token accounting, shared by the header's USAGE meter and the DOOM
// status bar. Pure and DOM-free so both can use it and neither owns it — the
// bar reads the same numbers the meter does, which is what stops the two
// panels ever disagreeing on screen.

import type { AgentStatus } from "../schema";

/** 14951815 -> "15M", 152300 -> "152K", 980 -> "980" */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * How much token budget the fleet has BURNED so far — summed across every live
 * session that reports a measurable budget.
 *
 * Each session's per-turn `<total_tokens> left` marker is its context-window
 * budget (budgetLeft), and its first marker is the budget it started with
 * (budgetTotal). Consumed = total − left. We sum consumed and total across all
 * measurable sessions, so the meter tells the honest story it can from local
 * data: how much the fleet has spent, a number that GROWS as agents work rather
 * than sitting pinned near full.
 *
 * A session with no known starting total can't yield a "used" figure, so it is
 * excluded rather than guessed. `used` is clamped to 0..total per session so a
 * stale head marker can't make it negative or exceed the budget. Returns null
 * when nothing measurable is live.
 */
export function fleetUsage(
  agents: AgentStatus[],
): { used: number; total: number; sessions: number; pct: number } | null {
  let used = 0;
  let total = 0;
  let sessions = 0;
  for (const a of agents) {
    const u = a.usage;
    if (!u || u.budgetTotal === undefined || u.budgetTotal <= 0) continue;
    const left = Math.max(0, Math.min(u.budgetTotal, u.budgetLeft));
    used += u.budgetTotal - left;
    total += u.budgetTotal;
    sessions++;
  }
  if (sessions === 0) return null;
  const pct = total > 0 ? Math.max(0, Math.min(1, used / total)) : 0;
  return { used, total, sessions, pct };
}
