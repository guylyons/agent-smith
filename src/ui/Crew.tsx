import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { paletteFor } from "./sprite-data";

export function Crew({ agents }: { agents: AgentStatus[] }) {
  return (
    <main className="crew">
      {agents.map((a) => {
        const { palette } = paletteFor(a.sessionId, a.role);
        return (
          <article key={a.sessionId} className={`win desk is-${a.state}`}>
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
