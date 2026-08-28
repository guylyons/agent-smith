import type { Snapshot } from "../lib/snapshot";
import { UsageMeter } from "./UsageMeter";

function projectName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function Header({ snap, onNewAgent }: { snap: Snapshot; onNewAgent: () => void }) {
  const { agents, board } = snap;
  const working = agents.filter((a) => a.state === "working").length;
  const waiting = agents.filter((a) => a.state === "waiting").length;
  const idle = agents.filter((a) => a.state === "idle").length;
  const onLine = board.cards.length;

  const first = agents[0];
  const project = first ? projectName(first.cwd) : null;
  const branch = first?.branch ?? null;

  return (
    <header>
      <UsageMeter agents={agents} />
      <div className="head-main">
        <div className="pix title">AGENT WORKSHOP</div>
        <div className="pix sub">
          {agents.length} ON SHIFT
          {project ? ` — ${project}` : ""}
          {branch ? ` · ${branch}` : ""}
          <span className="caret"></span>
        </div>
        <div className="pix statline">
          <span><b>{working}</b> WORKING</span>
          <span><b>{waiting}</b> NEED YOU</span>
          <span><b>{idle}</b> IDLE</span>
          <span><b>{onLine}</b> ON THE LINE</span>
          <button className="newagent-btn" onClick={onNewAgent}>+ NEW AGENT</button>
        </div>
      </div>
    </header>
  );
}
