import type { AgentStatus } from "../schema";

const CELLS = 20;

/** 14951815 -> "15.0M", 152300 -> "152K", 980 -> "980" */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * The header's Claude usage meter — an HP bar over the live fleet's token
 * budgets. Fill = tokens LEFT (a draining life meter), summed across every
 * session that reports a budget; sessions without one don't contribute.
 * "Used" needs each session's starting total, so it reads "?" until at least
 * one total is known.
 */
export function UsageMeter({ agents }: { agents: AgentStatus[] }) {
  const tracked = agents.filter((a) => a.usage);
  const left = tracked.reduce((n, a) => n + a.usage!.budgetLeft, 0);
  // A session with an unknown total contributes its "left" to both sums: the
  // meter never claims usage it can't see.
  const total = tracked.reduce((n, a) => n + (a.usage!.budgetTotal ?? a.usage!.budgetLeft), 0);
  const anyTotal = tracked.some((a) => a.usage!.budgetTotal !== undefined);
  const used = anyTotal ? total - left : null;

  const pct = total > 0 ? left / total : 0;
  const lit = tracked.length ? Math.max(pct > 0 ? 1 : 0, Math.round(pct * CELLS)) : 0;
  const tone = !tracked.length ? "" : pct <= 0.25 ? " hp-low" : pct <= 0.5 ? " hp-warn" : "";

  const text = tracked.length
    ? `${fmtTokens(left)} LEFT · ${used !== null ? fmtTokens(used) : "?"} USED`
    : "NO USAGE DATA";

  return (
    <div
      className={`usage${tone}`}
      role="meter"
      aria-label="Claude token budget"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={left}
      aria-valuetext={text}
      title={tracked.length
        ? `${left.toLocaleString()} of ${total.toLocaleString()} tokens left across ${tracked.length} session${tracked.length > 1 ? "s" : ""}`
        : "No live session reports a token budget"}
    >
      <div className="pix usage-label">CLAUDE USAGE</div>
      <div className="usage-bar" aria-hidden="true">
        {Array.from({ length: CELLS }, (_, i) => (
          <span key={i} className={`usage-cell${i < lit ? " on" : ""}`} />
        ))}
      </div>
      <div className="pix usage-text">{text}</div>
    </div>
  );
}
