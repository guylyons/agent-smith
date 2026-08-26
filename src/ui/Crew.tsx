import { memo } from "react";
import type { MouseEvent } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { paletteFor } from "./sprite-data";
import { focusSession } from "./actions";

const stop = (e: MouseEvent) => e.stopPropagation();

// A fresh snapshot arrives every ~20s with new agent objects; only re-render a
// card when a field it actually shows changed.
const AgentCard = memo(function AgentCard({ a, onOpen }: { a: AgentStatus; onOpen: (id: string) => void }) {
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
        {!!a.subagents && a.subagents > 0 && (
          <div className="pix crew-badge" title={`${a.subagents} subagent${a.subagents > 1 ? "s" : ""} working`}>⊂{a.subagents}</div>
        )}
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
}, (prev, next) => {
  const x = prev.a, y = next.a;
  return prev.onOpen === next.onOpen &&
    x.sessionId === y.sessionId && x.name === y.name && x.role === y.role &&
    x.ticket === y.ticket && x.state === y.state && x.doing === y.doing &&
    x.subagents === y.subagents;
});

export function Crew({ agents, onOpen }: { agents: AgentStatus[]; onOpen: (id: string) => void }) {
  return (
    <main className="crew">
      {agents.map((a) => <AgentCard key={a.sessionId} a={a} onOpen={onOpen} />)}
    </main>
  );
}
