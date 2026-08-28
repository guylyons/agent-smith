import type { AgentStatus } from "../schema";

const CELLS = 20;

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

/**
 * The header's usage meter — how many tokens the live fleet has consumed so far.
 * Fill = usage SPENT (a filling bar), so it climbs as agents actually work
 * instead of the old headroom meter that sat pinned near full. Amber past 50%
 * spent, red past 75%. Empty/"no data" when nothing reports a measurable budget.
 */
export function UsageMeter({ agents }: { agents: AgentStatus[] }) {
  const u = fleetUsage(agents);
  const pct = u ? u.pct : 0;
  const lit = u ? Math.min(CELLS, Math.round(pct * CELLS)) : 0;
  const tone = !u ? "" : pct >= 0.75 ? " hp-low" : pct >= 0.5 ? " hp-warn" : "";

  const text = u
    ? `${fmtTokens(u.used)} used · ${u.sessions} session${u.sessions === 1 ? "" : "s"}`
    : "NO USAGE DATA";

  return (
    <div
      className={`usage${tone}`}
      role="meter"
      aria-label="Fleet token usage"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      aria-valuetext={u ? `${fmtTokens(u.used)} tokens used across ${u.sessions} live session${u.sessions === 1 ? "" : "s"}` : "no usage data"}
      title={u
        ? `${fmtTokens(u.used)} of ${fmtTokens(u.total)} tokens used across ${u.sessions} live session${u.sessions === 1 ? "" : "s"} (${Math.round(pct * 100)}%)`
        : "No live session reports a token budget"}
    >
      <div className="pix usage-label">USAGE</div>
      <div className="usage-bar" aria-hidden="true">
        {Array.from({ length: CELLS }, (_, i) => (
          <span key={i} className={`usage-cell${i < lit ? " on" : ""}`} />
        ))}
      </div>
      <div className="pix usage-text">{text}</div>
    </div>
  );
}
