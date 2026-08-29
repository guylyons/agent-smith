import type { AgentStatus } from "../schema";
import { fleetUsage, fmtTokens } from "../lib/usage";

// The maths moved to lib/usage.ts so the status bar can share it; re-exported
// here because this module was its public home first.
export { fleetUsage, fmtTokens };

const CELLS = 20;

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
