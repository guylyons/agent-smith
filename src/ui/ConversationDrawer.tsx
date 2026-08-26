import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import {
  fetchConversation, fetchSubagents, sendPromptTo, focusSession, pauseSession, renameSession,
  type ChatMessage, type Subagent,
} from "./actions";

export function ConversationDrawer({ agent, ended, onClose }: { agent: AgentStatus; ended: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [pending, setPending] = useState<string[]>([]); // optimistic, not yet in transcript
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(agent.name);
  const [confirmPause, setConfirmPause] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Load + poll the conversation and subagents while open.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [m, s] = await Promise.all([fetchConversation(agent.sessionId), fetchSubagents(agent.sessionId)]);
      if (!alive) return;
      setMessages(m);
      setSubagents(s);
      // drop optimistic echoes once they show up in the real transcript
      setPending((prev) => prev.filter((p) => !m.some((msg) => msg.role === "user" && msg.text.trim() === p.trim())));
      setLoaded(true);
    };
    void load();
    const id = setInterval(load, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [agent.sessionId]);

  // Keep pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setText("");
    setPending((p) => [...p, t]); // optimistic echo
    atBottomRef.current = true;
    const ok = await sendPromptTo(agent.sessionId, t);
    setBusy(false);
    if (!ok) setPending((p) => p.filter((x) => x !== t)); // roll back on failure
  }

  function commitRename() {
    const n = nameDraft.trim();
    if (n && n !== agent.name) renameSession(agent.sessionId, n);
    setEditingName(false);
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="win drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-sprite"><Sprite sessionId={agent.sessionId} role={agent.role} state={agent.state} /></div>
          <div className="drawer-id">
            {editingName ? (
              <input className="reply-input name-input" autoFocus value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") { setNameDraft(agent.name); setEditingName(false); }
                }} />
            ) : (
              <div className="pix name name-click" title="Click to rename"
                onClick={() => { setNameDraft(agent.name); setEditingName(true); }}>{agent.name}</div>
            )}
            <div className="pix spec">{agent.role}{agent.ticket ? ` · ${agent.ticket}` : ""}</div>
            <div className="pix state">
              <span className={`lamp ${ended ? "idle" : agent.state}`}></span>
              {ended ? "ENDED" : agent.state.toUpperCase()}
            </div>
          </div>
          <div className="drawer-btns">
            <button className="deskbtn" title="Jump to this terminal in Ghostty" onClick={() => focusSession(agent.sessionId)}>↗ TERMINAL</button>
            {confirmPause ? (
              <>
                <button className="deskbtn danger" onClick={() => { pauseSession(agent.sessionId); setConfirmPause(false); }}>CONFIRM ⏸</button>
                <button className="deskbtn" onClick={() => setConfirmPause(false)}>✕</button>
              </>
            ) : (
              <button className="deskbtn" title="Pause (interrupt) this agent" onClick={() => setConfirmPause(true)}>⏸</button>
            )}
            <button className="deskbtn" title="Close" onClick={onClose}>✕</button>
          </div>
        </header>

        {subagents.length > 0 && (
          <div className="subagents">
            <div className="pix subagents-head">SUBAGENTS · {subagents.length}</div>
            {subagents.map((s) => (
              <div key={s.agentId} className={`subagent ${s.active ? "is-active" : ""}`}>
                <span className={`lamp ${s.active ? "working" : "idle"}`}></span>
                <span className="subagent-desc" title={`${s.agentType}${s.model ? " · " + s.model : ""}`}>{s.description}</span>
                <span className="subagent-doing">{s.doing}</span>
              </div>
            ))}
          </div>
        )}

        <div className="drawer-body" ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}>
          {!loaded && <div className="msg-empty">loading conversation…</div>}
          {loaded && messages.length === 0 && pending.length === 0 && <div className="msg-empty">No conversation yet.</div>}
          {messages.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>
              <span className="msg-who">{m.role === "user" ? "YOU" : m.role === "assistant" ? agent.name : "»"}</span>
              <span className="msg-text">{m.text}</span>
            </div>
          ))}
          {pending.map((p, i) => (
            <div key={`p${i}`} className="msg msg-user is-pending">
              <span className="msg-who">YOU</span>
              <span className="msg-text">{p}</span>
            </div>
          ))}
        </div>

        <div className="drawer-foot">
          <input
            className="reply-input"
            autoFocus
            placeholder={ended ? "Session ended" : `Message ${agent.name}… (Enter to send)`}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void send(); }
              if (e.key === "Escape") onClose();
            }}
          />
          <button className="deskbtn" disabled={busy} onClick={() => void send()}>▸ SEND</button>
        </div>
      </aside>
    </div>
  );
}
