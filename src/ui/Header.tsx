import type { Snapshot } from "../lib/snapshot";
import type { AgentStatus } from "../schema";
import { UsageMeter } from "./UsageMeter";
import { NotificationCenter } from "./NotificationCenter";

function projectName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * The actionable header readout: how many agents are genuinely working, how
 * many are waiting on the human, and how many distinct repos are active. Idle
 * agents are excluded — "on shift" should mean actually doing something — which
 * is why the old raw agent count (idle included) and its duplicated repo/branch
 * are gone. Pure and exported for unit testing.
 */
export function headerSummary(agents: AgentStatus[]): { working: number; waiting: number; repos: number } {
  const working = agents.filter((a) => a.state === "working").length;
  const waiting = agents.filter((a) => a.state === "waiting").length;
  const repos = new Set(
    agents.filter((a) => a.state !== "idle").map((a) => projectName(a.cwd)),
  ).size;
  return { working, waiting, repos };
}

export function Header({ snap, live, onNewAgent, onFind }: { snap: Snapshot; live: boolean; onNewAgent: () => void; onFind: () => void }) {
  const { agents, board } = snap;
  const idle = agents.filter((a) => a.state === "idle").length;
  const onLine = board.cards.length;

  const { working, waiting, repos } = headerSummary(agents);
  // Only surface segments that carry a signal; a quiet fleet says so plainly
  // rather than showing a row of zeros.
  const parts: string[] = [];
  if (working) parts.push(`${working} WORKING`);
  if (waiting) parts.push(`${waiting} NEEDS YOU`);
  if (repos) parts.push(`${repos} ${repos === 1 ? "REPO" : "REPOS"}`);
  const summary = parts.length ? parts.join(" · ") : "ALL QUIET";

  return (
    <header>
      <UsageMeter agents={agents} />
      <div className="head-main">
        <NotificationCenter snap={snap} />
        <div className="pix title">AGENT WORKSHOP</div>
        {/* A dropped connection leaves the whole page showing stale data with no
            outward sign, which reads as "nothing is happening" rather than "you
            are not connected". Say so, and let the summary stand aside. */}
        <div className={`pix sub${!live ? " offline" : waiting ? " needs-you" : ""}`}>
          {live ? summary : "RECONNECTING — BOARD MAY BE STALE"}
          <span className="caret"></span>
        </div>
        <div className="pix statline">
          <span><b>{idle}</b> IDLE</span>
          <span><b>{onLine}</b> TASKS</span>
          <button className="newagent-btn find-btn" onClick={onFind} title="Find a ticket, desk, or chat (Alt+P)">FIND</button>
          <button className="newagent-btn" onClick={onNewAgent}>+ NEW AGENT</button>
        </div>
      </div>
    </header>
  );
}
