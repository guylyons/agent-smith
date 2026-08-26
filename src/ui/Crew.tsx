import type { MouseEvent } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { paletteFor } from "./sprite-data";
import { focusSession, pauseSession, renameSession } from "./actions";

export function Crew({ agents }: { agents: AgentStatus[] }) {
  return (
    <main className="crew">
      {agents.map((a) => {
        const { palette } = paletteFor(a.sessionId, a.role);
        const stop = (e: MouseEvent) => e.stopPropagation();
        return (
          <article
            key={a.sessionId}
            className={`win desk is-${a.state}`}
            role="button"
            tabIndex={0}
            title="Click to jump to this terminal in Ghostty"
            onClick={() => focusSession(a.sessionId)}
            onKeyDown={(e) => { if (e.key === "Enter") focusSession(a.sessionId); }}
          >
            <div className="desk-actions" onClick={stop}>
              <button className="deskbtn" title="Rename this agent"
                onClick={() => renameSession(a.sessionId, a.name)}>✎</button>
              <button className="deskbtn" title="Pause (interrupt) this agent"
                onClick={() => pauseSession(a.sessionId, a.name)}>⏸</button>
            </div>
            <div className="sprite-wrap">
              <Sprite sessionId={a.sessionId} role={a.role} state={a.state} />
              {a.state === "waiting" && <div className="pix bubble">!</div>}
            </div>
            <div className="who">
              <div className="pix name">{a.name}</div>
              <div className="pix spec">{a.role}</div>
              <div className="pix ticket" style={{ color: palette.G }}>
                {a.ticket ?? "—"}
              </div>
              <div className="doing">{a.doing}</div>
              <div className="pix state">
                <span className={`lamp ${a.state}`}></span>
                {a.state.toUpperCase()}
              </div>
            </div>
          </article>
        );
      })}
    </main>
  );
}
