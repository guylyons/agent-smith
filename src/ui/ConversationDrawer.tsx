import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import {
  fetchConversation, sendPromptTo, focusSession, pauseSession, renameSession,
  type ChatMessage,
} from "./actions";

export function ConversationDrawer({ agent, onClose }: { agent: AgentStatus; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Load + poll the conversation while open.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const m = await fetchConversation(agent.sessionId);
      if (!alive) return;
      setMessages(m);
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
  }, [messages]);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await sendPromptTo(agent.sessionId, text);
    setBusy(false);
    if (ok) { setText(""); atBottomRef.current = true; }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="win drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-sprite"><Sprite sessionId={agent.sessionId} role={agent.role} state={agent.state} /></div>
          <div className="drawer-id">
            <div className="pix name">{agent.name}</div>
            <div className="pix spec">{agent.role}{agent.ticket ? ` · ${agent.ticket}` : ""}</div>
            <div className="pix state"><span className={`lamp ${agent.state}`}></span>{agent.state.toUpperCase()}</div>
          </div>
          <div className="drawer-btns">
            <button className="deskbtn" title="Jump to this terminal in Ghostty" onClick={() => focusSession(agent.sessionId)}>↗ TERMINAL</button>
            <button className="deskbtn" title="Rename" onClick={() => renameSession(agent.sessionId, agent.name)}>✎</button>
            <button className="deskbtn" title="Pause (interrupt)" onClick={() => pauseSession(agent.sessionId, agent.name)}>⏸</button>
            <button className="deskbtn" title="Close" onClick={onClose}>✕</button>
          </div>
        </header>

        <div className="drawer-body" ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}>
          {!loaded && <div className="msg-empty">loading conversation…</div>}
          {loaded && messages.length === 0 && <div className="msg-empty">No conversation yet.</div>}
          {messages.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>
              <span className="msg-who">{m.role === "user" ? "YOU" : m.role === "assistant" ? agent.name : "»"}</span>
              <span className="msg-text">{m.text}</span>
            </div>
          ))}
        </div>

        <div className="drawer-foot">
          <input
            className="reply-input"
            autoFocus
            placeholder={`Message ${agent.name}… (Enter to send)`}
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
