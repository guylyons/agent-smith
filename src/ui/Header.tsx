import type { Snapshot } from "../lib/snapshot";
import type { AgentStatus } from "../schema";
import { UsageMeter } from "./UsageMeter";
import { NotificationCenter } from "./NotificationCenter";
import type { AppView } from "./view";

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

export function Header({ snap, live, view, onView, onNewAgent, onFind, onSettings }: { snap: Snapshot; live: boolean; view: AppView; onView: (v: AppView) => void; onNewAgent: () => void; onFind: () => void; onSettings: () => void }) {
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
          {/* The two pages: the desks + THE LINE, or the big-picture MOOD board. */}
          <span className="view-tabs" role="group" aria-label="View">
            <button className={`view-tab${view === "workshop" ? " on" : ""}`} aria-pressed={view === "workshop"} onClick={() => onView("workshop")}>WORKSHOP</button>
            <button className={`view-tab${view === "mood" ? " on" : ""}`} aria-pressed={view === "mood"} onClick={() => onView("mood")} title="The big picture: what we're on, what's at risk, what's next">MOOD</button>
          </span>
          {/* CONFIG used to be a cog pinned to the top-right corner, floating over
              whatever it happened to land on. It belongs with the other things you
              can do to the workshop, in the row the eye already scans. */}
          <button className="newagent-btn quiet-btn" onClick={onSettings} title="Theme, display, background, alerts">CONFIG</button>
          <button className="newagent-btn quiet-btn" onClick={onFind} title="Find a ticket, desk, or chat (Alt+P)">FIND</button>
          <button className="newagent-btn" onClick={onNewAgent}>+ NEW AGENT</button>
        </div>
      </div>
    </header>
  );
}
