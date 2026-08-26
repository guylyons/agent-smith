import type { MouseEvent } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { paletteFor } from "./sprite-data";
import { focusSession } from "./actions";

const stop = (e: MouseEvent) => e.stopPropagation();

function AgentCard({ a, onOpen }: { a: AgentStatus; onOpen: (id: string) => void }) {
  const { palette } = paletteFor(a.sessionId, a.role);
  return (
    <article
      className={`win desk is-${a.state}`}
      role="button"
      tabIndex={0}
      title="Click to open this agent's conversation"
      onClick={() => onOpen(a.sessionId)}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(a.sessionId); }}
    >
      <div className="desk-actions" onClick={stop}>
        <button className="deskbtn" title="Jump to this terminal in Ghostty"
          onClick={() => focusSession(a.sessionId)}>↗ TERMINAL</button>
      </div>
      <div className="sprite-wrap">
        <Sprite sessionId={a.sessionId} role={a.role} state={a.state} />
        {a.state === "waiting" && <div className="pix bubble">!</div>}
      </div>
      <div className="who">
        <div className="pix name">{a.name}</div>
        <div className="pix spec">{a.role}</div>
        <div className="pix ticket" style={{ color: palette.G }}>{a.ticket ?? "—"}</div>
        <div className="doing">{a.doing}</div>
        <div className="pix state">
          <span className={`lamp ${a.state}`}></span>
          {a.state.toUpperCase()}
        </div>
      </div>
    </article>
  );
}

export function Crew({ agents, onOpen }: { agents: AgentStatus[]; onOpen: (id: string) => void }) {
  return (
    <main className="crew">
      {agents.map((a) => <AgentCard key={a.sessionId} a={a} onOpen={onOpen} />)}
    </main>
  );
}
