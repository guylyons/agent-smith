import { useState } from "react";
import type { MouseEvent } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { paletteFor } from "./sprite-data";
import { focusSession, pauseSession, renameSession, sendPromptTo } from "./actions";

const stop = (e: MouseEvent) => e.stopPropagation();

function AgentCard({ a }: { a: AgentStatus }) {
  const { palette } = paletteFor(a.sessionId, a.role);
  const asking = a.state === "waiting" && a.waitingReason === "question";
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await sendPromptTo(a.sessionId, text);
    setBusy(false);
    if (ok) { setText(""); setOpen(false); }
  }

  return (
    <article
      className={`win desk is-${a.state}`}
      role="button"
      tabIndex={0}
      title="Click to jump to this terminal in Ghostty"
      onClick={() => focusSession(a.sessionId)}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) focusSession(a.sessionId); }}
    >
      <div className="desk-actions" onClick={stop}>
        <button className="deskbtn" title={asking ? "Answer this agent" : "Send a prompt"}
          onClick={() => setOpen((o) => !o)}>⌨</button>
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
        <div className="pix ticket" style={{ color: palette.G }}>{a.ticket ?? "—"}</div>
        <div className="doing">{a.doing}</div>
        <div className="pix state">
          <span className={`lamp ${a.state}`}></span>
          {a.state.toUpperCase()}
        </div>
        {(open || asking) && (
          <div className="reply" onClick={stop}>
            <input
              className="reply-input"
              autoFocus={open}
              placeholder={asking ? "Type your answer… (Enter)" : "Send a prompt… (Enter)"}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void send(); }
                if (e.key === "Escape") { setOpen(false); setText(""); }
              }}
            />
            <button className="deskbtn" disabled={busy} onClick={() => void send()}>▸</button>
          </div>
        )}
      </div>
    </article>
  );
}

export function Crew({ agents }: { agents: AgentStatus[] }) {
  return (
    <main className="crew">
      {agents.map((a) => <AgentCard key={a.sessionId} a={a} />)}
    </main>
  );
}
