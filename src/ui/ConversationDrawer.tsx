import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { SpritePicker } from "./SpritePicker";
import { renderMarkdown } from "./markdown";
import {
  fetchConversation, fetchSubagents, fetchRepo, sendPromptTo, focusSession, pauseSession, renameSession, killAgent,
  type ChatMessage, type Subagent, type RepoInfo, type PendingQuestion,
} from "./actions";

type Pending = { id: string; text: string; base: number; at: number };

export function ConversationDrawer({ agent, ended, onClose }: { agent: AgentStatus; ended: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"chat" | "info">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [pending, setPending] = useState<Pending[]>([]); // optimistic, not yet in transcript
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const [picks, setPicks] = useState<Record<number, Set<string>>>({});
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(agent.name);
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pickSprite, setPickSprite] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the message textarea (up to a cap) as the user types multi-line.
  useEffect(() => {
    const t = taRef.current;
    if (t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }
  }, [text]);

  // Load + poll the conversation and subagents while open.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [conv, s] = await Promise.all([fetchConversation(agent.sessionId), fetchSubagents(agent.sessionId)]);
      if (!alive) return;
      const m = conv.messages;
      setMessages(m);
      setSubagents(s);
      setQuestion(conv.question);
      // Drop an optimistic echo once a NEW occurrence of its text lands in the
      // transcript (count exceeds the baseline captured at send time), or after
      // 30s if it never shows — so repeated identical messages aren't swallowed.
      const nowT = Date.now();
      setPending((prev) => prev.filter((p) => {
        const count = m.filter((msg) => msg.role === "user" && msg.text.trim() === p.text.trim()).length;
        return count <= p.base && nowT - p.at < 30_000;
      }));
      setLoaded(true);
    };
    void load();
    const id = setInterval(load, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [agent.sessionId]);

  // Load + poll the repo info only while the INFO tab is open.
  useEffect(() => {
    if (tab !== "info") return;
    let alive = true;
    const load = async () => { const r = await fetchRepo(agent.sessionId); if (alive) setRepo(r); };
    void load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [tab, agent.sessionId]);

  // Keep pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (tab === "chat" && el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending, tab]);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setText("");
    const id = `${Date.now()}-${Math.random()}`;
    const base = messages.filter((msg) => msg.role === "user" && msg.text.trim() === t).length;
    setPending((p) => [...p, { id, text: t, base, at: Date.now() }]);
    atBottomRef.current = true;
    const ok = await sendPromptTo(agent.sessionId, t);
    setBusy(false);
    if (!ok) setPending((p) => p.filter((x) => x.id !== id)); // roll back on failure
  }

  async function answer(text: string) {
    const id = `${Date.now()}-${Math.random()}`;
    const base = messages.filter((msg) => msg.role === "user" && msg.text.trim() === text.trim()).length;
    setPending((p) => [...p, { id, text, base, at: Date.now() }]);
    setQuestion(null); setPicks({});
    atBottomRef.current = true;
    const ok = await sendPromptTo(agent.sessionId, text);
    if (!ok) setPending((p) => p.filter((x) => x.id !== id));
  }
  function togglePick(qi: number, label: string, multi: boolean) {
    setPicks((p) => {
      const s = new Set(multi ? p[qi] ?? [] : []); // single-select replaces
      if (s.has(label)) s.delete(label); else s.add(label);
      return { ...p, [qi]: s };
    });
  }
  function sendAnswer() {
    const parts = (question?.questions ?? []).map((_, qi) => [...(picks[qi] ?? [])].join(", ")).filter(Boolean);
    if (parts.length) void answer(parts.join(" | "));
  }
  const singleQ = !!question && question.questions.length === 1 && !question.questions[0].multiSelect;

  function commitRename() {
    const n = nameDraft.trim();
    if (n && n !== agent.name) renameSession(agent.sessionId, n);
    setEditingName(false);
  }

  return (
    <>
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="win drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-sprite" title="Change sprite" style={{ cursor: "pointer" }} onClick={() => setPickSprite(true)}>
            <Sprite sessionId={agent.sessionId} role={agent.role} state={agent.state} override={agent.sprite} />
          </div>
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
            <button className="deskbtn" title="Change this agent's sprite" onClick={() => setPickSprite(true)}>◈ SPRITE</button>
            <button className="deskbtn" title="Jump to this terminal in Ghostty" onClick={() => focusSession(agent.sessionId)}>↗ TERMINAL</button>
            {confirmPause ? (
              <>
                <button className="deskbtn danger" onClick={() => { pauseSession(agent.sessionId); setConfirmPause(false); }}>CONFIRM ⏸</button>
                <button className="deskbtn" onClick={() => setConfirmPause(false)}>✕</button>
              </>
            ) : (
              <button className="deskbtn" title="Pause (interrupt) this agent" onClick={() => setConfirmPause(true)}>⏸</button>
            )}
            {confirmStop ? (
              <>
                <button className="deskbtn danger" onClick={() => { killAgent(agent.sessionId); setConfirmStop(false); onClose(); }}>CONFIRM ◼</button>
                <button className="deskbtn" onClick={() => setConfirmStop(false)}>✕</button>
              </>
            ) : (
              <button className="deskbtn" title="Stop (end) this agent" onClick={() => setConfirmStop(true)}>◼</button>
            )}
            <button className="deskbtn" title="Close" onClick={onClose}>✕</button>
          </div>
        </header>

        <div className="drawer-tabs">
          <button className={`tab ${tab === "chat" ? "on" : ""}`} onClick={() => setTab("chat")}>CHAT</button>
          <button className={`tab ${tab === "info" ? "on" : ""}`} onClick={() => setTab("info")}>INFO</button>
        </div>

        {tab === "chat" ? (
          <>
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
                  <span className="msg-text">{m.role === "tool" ? m.text : renderMarkdown(m.text)}</span>
                </div>
              ))}
              {pending.map((p) => (
                <div key={p.id} className="msg msg-user is-pending">
                  <span className="msg-who">YOU</span>
                  <span className="msg-text">{p.text}</span>
                </div>
              ))}
            </div>

            {question && (
              <div className="qpanel">
                {question.questions.map((q, qi) => (
                  <div key={qi} className="qblock">
                    {q.header && <div className="pix qheader">{q.header}</div>}
                    <div className="qtext">{q.question}</div>
                    <div className="qoptions">
                      {q.options.map((o) => {
                        const selected = picks[qi]?.has(o.label);
                        return (
                          <button key={o.label} className={`deskbtn qopt ${selected ? "on" : ""}`} title={o.description}
                            onClick={() => (singleQ ? void answer(o.label) : togglePick(qi, o.label, q.multiSelect))}>
                            {!singleQ && (q.multiSelect ? (selected ? "☑ " : "☐ ") : (selected ? "◉ " : "○ "))}{o.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {!singleQ && <button className="deskbtn primary" onClick={sendAnswer}>▸ SEND ANSWER</button>}
              </div>
            )}

            {!ended && agent.state === "working" && (
              <div className="thinking-pill"><span className="thinking-spin">✻</span> {agent.doing || "thinking"}…</div>
            )}

            <div className="drawer-foot">
              <textarea
                ref={taRef}
                className="reply-input reply-textarea"
                autoFocus
                rows={1}
                placeholder={ended ? "Session ended" : `Message ${agent.name}… (Enter to send · Shift+Enter for newline)`}
                value={text}
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
                  if (e.key === "Escape") onClose();
                }}
              />
              <button className="deskbtn" disabled={busy} onClick={() => void send()}>▸ SEND</button>
            </div>
          </>
        ) : (
          <div className="drawer-body info">
            {!repo && <div className="msg-empty">loading repo…</div>}
            {repo && (
              <>
                <div className="info-row"><span className="info-k">PWD</span><span className="info-v">{repo.cwd}</span></div>
                <div className="info-row"><span className="info-k">BRANCH</span><span className="info-v">{repo.branch || "—"}{agent.ticket ? ` · ${agent.ticket}` : ""}</span></div>
                <div className="pix info-sec">WORKING TREE {repo.status.length ? `· ${repo.status.length} changed` : "· clean"}</div>
                {repo.status.map((s, i) => (
                  <div key={i} className="info-file"><span className="info-code">{s.code || "·"}</span>{s.file}</div>
                ))}
                <div className="pix info-sec">RECENT COMMITS</div>
                {repo.commits.length === 0 && <div className="msg-empty">no commits (or not a git repo)</div>}
                {repo.commits.map((c, i) => (
                  <div key={i} className="info-commit"><span className="info-hash">{c.hash}</span>{c.subject}</div>
                ))}
              </>
            )}
          </div>
        )}
      </aside>
    </div>
    {pickSprite && <SpritePicker agent={agent} onClose={() => setPickSprite(false)} />}
    </>
  );
}
