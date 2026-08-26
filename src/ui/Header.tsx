import type { Snapshot } from "../lib/snapshot";

function projectName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function Header({ snap }: { snap: Snapshot }) {
  const { agents, line } = snap;
  const working = agents.filter((a) => a.state === "working").length;
  const waiting = agents.filter((a) => a.state === "waiting").length;
  const idle = agents.filter((a) => a.state === "idle").length;
  const open = line
    .filter((l) => l.stage !== "merged")
    .reduce((n, l) => n + l.tickets.length, 0);

  const first = agents[0];
  const project = first ? projectName(first.cwd) : null;
  const branch = first?.branch ?? null;

  return (
    <header>
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
        <span><b>{open}</b> TICKETS OPEN</span>
      </div>
    </header>
  );
}
