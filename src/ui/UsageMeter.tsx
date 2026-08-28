import type { AgentStatus } from "../schema";

const CELLS = 20;

/** 14951815 -> "15.0M", 152300 -> "152K", 980 -> "980" */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * The busiest live session's remaining context, or null when nothing can be
 * measured.
 *
 * The per-turn `<total_tokens> left` marker the scanner reads is the session's
 * CONTEXT-window budget, not the account/rate-limit quota that `/usage` reports
 * — there is no local source for the latter. So this meter tells the honest
 * story it can: how much context headroom the most-loaded session has left
 * (budgetLeft / budgetTotal), the one closest to needing a compact.
 *
 * A session with no known starting total can't be turned into a fraction, so it
 * is excluded rather than counted as full — the bug that used to pin the old
 * meter to 100%. The result is clamped to 0..1.
 */
export function contextHeadroom(
  agents: AgentStatus[],
): { pct: number; left: number; total: number; name: string } | null {
  let worst: { pct: number; left: number; total: number; name: string } | null = null;
  for (const a of agents) {
    const u = a.usage;
    if (!u || u.budgetTotal === undefined || u.budgetTotal <= 0) continue;
    const pct = Math.max(0, Math.min(1, u.budgetLeft / u.budgetTotal));
    if (!worst || pct < worst.pct) {
      worst = { pct, left: u.budgetLeft, total: u.budgetTotal, name: a.name };
    }
  }
  return worst;
}

/**
 * The header's context meter — an HP bar showing the remaining context headroom
 * of the busiest live session (see contextHeadroom). Fill = headroom LEFT (a
 * draining life meter), so it only falls as a session actually fills its
 * context. Amber under 50%, red under 25%. Empty/"no data" when nothing reports
 * a measurable budget, rather than reading full.
 */
export function UsageMeter({ agents }: { agents: AgentStatus[] }) {
  const hp = contextHeadroom(agents);
  const pct = hp ? hp.pct : 0;
  const lit = hp ? Math.max(1, Math.round(pct * CELLS)) : 0;
  const tone = !hp ? "" : pct <= 0.25 ? " hp-low" : pct <= 0.5 ? " hp-warn" : "";

  const text = hp ? `${Math.round(pct * 100)}% · ${hp.name}` : "NO CONTEXT DATA";

  return (
    <div
      className={`usage${tone}`}
      role="meter"
      aria-label="Busiest session context headroom"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      aria-valuetext={hp ? `${Math.round(pct * 100)}% context left on ${hp.name}` : "no context data"}
      title={hp
        ? `${hp.name}: ${hp.left.toLocaleString()} of ${hp.total.toLocaleString()} context tokens left (${Math.round(pct * 100)}%) — the busiest live session`
        : "No live session reports a context budget"}
    >
      <div className="pix usage-label">CONTEXT</div>
      <div className="usage-bar" aria-hidden="true">
        {Array.from({ length: CELLS }, (_, i) => (
          <span key={i} className={`usage-cell${i < lit ? " on" : ""}`} />
        ))}
      </div>
      <div className="pix usage-text">{text}</div>
    </div>
  );
}
