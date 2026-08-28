import { useEffect, useRef, useState, type DragEvent, type ClipboardEvent } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { ModalBackdrop } from "./Backdrop";
import { SpritePicker } from "./SpritePicker";
import { renderMarkdown } from "./markdown";
import { toast } from "./toast";
import {
  fetchConversation, fetchSubagents, fetchRepo, fetchPersonas, sendPromptTo, uploadImage, focusSession, pauseSession, renameSession, killAgent,
  type ChatMessage, type Subagent, type RepoInfo, type PendingQuestion, type PersonaInfo, type BlockingTool,
} from "./actions";

type Pending = { id: string; text: string; base: number; at: number };
type Attachment = { id: string; name: string; path: string };

// basename of a saved upload path, for the chip label
function baseOf(path: string): string {
  return path.split("/").pop() || path;
}

export function ConversationDrawer({ agent, ended, onClose }: { agent: AgentStatus; ended: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"chat" | "info">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [pending, setPending] = useState<Pending[]>([]); // optimistic, not yet in transcript
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const [blocked, setBlocked] = useState<BlockingTool | null>(null);
  const [picks, setPicks] = useState<Record<number, Set<string>>>({});
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const attachSeq = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(agent.name);
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pickSprite, setPickSprite] = useState(false);
  const [focusing, setFocusing] = useState(false);
  // Which waiting episode (by its stateSince) the user has manually dismissed.
  // Lets a stuck/stale permission panel be closed by hand; a NEW waiting episode
  // (different stateSince) brings the panel back.
  const [dismissedSince, setDismissedSince] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false); // synchronous re-entrancy guard; `busy` state lags a render

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
      if (s) setSubagents(s);
      setLoaded(true);
      if (!conv) return; // a failed poll: keep the chat we already have on screen
      const m = conv.messages;
      setMessages(m);
      setQuestion(conv.question);
      setBlocked(conv.blocked);
      // Drop an optimistic echo once a NEW occurrence of its text lands in the
      // transcript (count exceeds the baseline captured at send time), or after
      // 30s if it never shows — so repeated identical messages aren't swallowed.
      const nowT = Date.now();
      setPending((prev) => prev.filter((p) => {
        const count = m.filter((msg) => msg.role === "user" && msg.text.trim() === p.text.trim()).length;
        return count <= p.base && nowT - p.at < 30_000;
      }));
    };
    void load();
    const id = setInterval(load, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [agent.sessionId]);

  // Load + poll the repo info only while the INFO tab is open.
  useEffect(() => {
    if (tab !== "info") return;
    let alive = true;
    // Keep the last good repo info on a failed poll (fetchRepo returns null) so a
    // single dropped request doesn't blank the INFO tab back to "loading repo…".
    const load = async () => { const r = await fetchRepo(agent.sessionId); if (alive && r) setRepo(r); };
    void load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [tab, agent.sessionId]);

  // Persona list is small and static — fetch it once when needed, not on the 4s poll.
  useEffect(() => {
    if (tab !== "info" || !agent.persona || personas.length) return;
    void fetchPersonas().then(setPersonas);
  }, [tab, agent.persona, personas.length]);

  // Keep pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (tab === "chat" && el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending, tab]);

  async function send() {
    const t = text.trim();
    // Send with attachments alone (image, no words) or text alone, but not empty.
    if ((!t && attachments.length === 0) || sendingRef.current) return; // ref, not `busy`: two Enters in one frame both see busy=false
    sendingRef.current = true;
    setBusy(true);
    // Prepend each saved image path on its own line so Claude Code reads them,
    // then the typed message. Paths lead; the text (if any) follows.
    const paths = attachments.map((a) => a.path);
    const outgoing = [...paths, ...(t ? [t] : [])].join("\n");
    // Remember what we cleared so a failed send can restore it — otherwise the
    // typed message and attachment chips are gone for good on a server hiccup.
    const prevText = text;
    const prevAttachments = attachments;
    setText("");
    setAttachments([]);
    const id = `${Date.now()}-${Math.random()}`;
    const base = messages.filter((msg) => msg.role === "user" && msg.text.trim() === outgoing.trim()).length;
    setPending((p) => [...p, { id, text: outgoing, base, at: Date.now() }]);
    atBottomRef.current = true;
    const ok = await sendPromptTo(agent.sessionId, outgoing);
    sendingRef.current = false;
    setBusy(false);
    if (!ok) {
      setPending((p) => p.filter((x) => x.id !== id)); // roll back the optimistic echo
      setText((cur) => cur || prevText); // ...and give the user their message back
      setAttachments((cur) => (cur.length ? cur : prevAttachments));
    }
    // Re-enabling the textarea after `busy` doesn't restore focus on its own, so
    // hand it back — otherwise the next keystrokes after every send go nowhere.
    taRef.current?.focus();
  }

  // Upload each image file and add it as an attachment chip. Non-image files
  // (and failed uploads) are skipped. Returns true if any file was an image, so
  // a paste with an image can suppress the default text paste.
  async function addImageFiles(files: Iterable<File>): Promise<boolean> {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return false;
    await Promise.all(images.map(async (f) => {
      const path = await uploadImage(f);
      if (!path) return;
      const id = `att-${attachSeq.current++}`;
      setAttachments((a) => [...a, { id, name: f.name || baseOf(path), path }]);
    }));
    return true;
  }

  function onDrop(e: DragEvent) {
    const files = e.dataTransfer?.files;
    if (files && files.length) { e.preventDefault(); void addImageFiles(files); }
    setDragOver(false);
  }

  function onPaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files;
    if (files && files.length && [...files].some((f) => f.type.startsWith("image/"))) {
      e.preventDefault(); // don't also paste a filename/blob into the textarea
      void addImageFiles(files);
    }
  }

  async function answer(text: string) {
    // Guard against a double-answer: the question panel stays rendered until the
    // agent's status clears server-side (`liveQ` falls back to the hook copy, and
    // the poll re-sets `question`), so without this a second click would fire the
    // answer prompt twice.
    if (sendingRef.current) return;
    sendingRef.current = true;
    const id = `${Date.now()}-${Math.random()}`;
    const base = messages.filter((msg) => msg.role === "user" && msg.text.trim() === text.trim()).length;
    setPending((p) => [...p, { id, text, base, at: Date.now() }]);
    setQuestion(null); setPicks({});
    atBottomRef.current = true;
    const ok = await sendPromptTo(agent.sessionId, text);
    sendingRef.current = false;
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
    const parts = (liveQ?.questions ?? []).map((_, qi) => [...(picks[qi] ?? [])].join(", ")).filter(Boolean);
    if (parts.length) void answer(parts.join(" | "));
  }
  // The transcript can NEVER show a question that is currently blocking: Claude Code
  // flushes a pending AskUserQuestion only once it's answered (backdated). So the
  // hook's PreToolUse capture on the status record is the live source, and the
  // transcript's copy is only ever a late confirmation. Prefer whichever exists.
  // `multiSelect` is optional on the wire (the hook stores what the tool sent) but
  // required in the UI's Question type — normalise it here, at the boundary.
  const hookQ: PendingQuestion | null =
    agent.state === "waiting" && agent.pendingQuestion
      ? { questions: agent.pendingQuestion.questions.map((q) => ({ ...q, multiSelect: !!q.multiSelect })) }
      : null;
  const liveQ: PendingQuestion | null = question ?? hookQ;
  const singleQ = !!liveQ && liveQ.questions.length === 1 && !liveQ.questions[0].multiSelect;

  function commitRename() {
    const n = nameDraft.trim();
    if (n && n !== agent.name) renameSession(agent.sessionId, n);
    setEditingName(false);
  }

  return (
    <>
    <ModalBackdrop onClose={onClose}>
      <aside className={`win drawer${dragOver ? " drag-over" : ""}`}
        onDragOver={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={onDrop}>
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

            {liveQ && (
              <div className="qpanel">
                {liveQ.questions.map((q, qi) => (
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

            {!liveQ && !ended && agent.state === "waiting" && dismissedSince !== (agent.stateSince ?? 0) && (
              <div className="qpanel">
                <div className="pix qheader">
                  {agent.waitingReason === "plan" ? "PLAN APPROVAL" : "NEEDS PERMISSION"}
                </div>
                {/* A permission prompt leaves NO trace in the transcript, so there is
                    often nothing to name. Say so plainly rather than render an empty
                    panel — the empty panel was the original bug. */}
                <div className="qtext">
                  {blocked ? `${blocked.name} · ${blocked.summary}` : "waiting for you in the terminal — it can't be read from here"}
                </div>
                {/* This panel can't send the answer (a permission/plan prompt takes
                    keystrokes in the terminal, not typed text), so it stays until the
                    agent's state clears server-side. Two escape hatches for when that
                    feels stuck: focus reports if it actually reached a terminal, and
                    Dismiss hides this episode by hand. */}
                <div className="qactions">
                  <button
                    className="deskbtn primary"
                    disabled={focusing}
                    onClick={async () => {
                      setFocusing(true);
                      const ok = await focusSession(agent.sessionId);
                      setFocusing(false);
                      if (ok) toast("Opened its terminal — answer there; this clears when you do");
                    }}
                  >
                    {focusing ? "OPENING…" : "↗ ANSWER IN TERMINAL"}
                  </button>
                  <button
                    className="deskbtn"
                    title="Hide this until the agent asks again"
                    onClick={() => setDismissedSince(agent.stateSince ?? 0)}
                  >
                    DISMISS
                  </button>
                </div>
              </div>
            )}

            {!ended && agent.state === "working" && (
              <div className="thinking-pill"><span className="thinking-spin">✻</span> {agent.doing || "thinking"}…</div>
            )}

            {attachments.length > 0 && (
              <div className="attach-row">
                {attachments.map((a) => (
                  <span key={a.id} className="attach-chip" title={a.path}>
                    <span className="attach-name">🖼 {a.name}</span>
                    <button className="attach-x" title="Remove"
                      onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}>✕</button>
                  </span>
                ))}
              </div>
            )}

            <div className="drawer-foot">
              <textarea
                ref={taRef}
                className="reply-input reply-textarea"
                autoFocus
                rows={1}
                placeholder={ended ? "Session ended" : `Message ${agent.name}… (Enter to send · Shift+Enter for newline · drop or paste an image)`}
                value={text}
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
                  if (e.key === "Escape") onClose();
                }}
              />
              <button className="deskbtn" disabled={busy || (!text.trim() && attachments.length === 0)} onClick={() => void send()}>▸ SEND</button>
            </div>
          </>
        ) : (
          <div className="drawer-body info">
            {!repo && <div className="msg-empty">loading repo…</div>}
            {repo && (
              <>
                <div className="info-row"><span className="info-k">PWD</span><span className="info-v">{repo.cwd}</span></div>
                <div className="info-row"><span className="info-k">BRANCH</span><span className="info-v">{repo.branch || "—"}{agent.ticket ? ` · ${agent.ticket}` : ""}</span></div>
                {agent.persona && (() => {
                  const p = personas.find((x) => x.id === agent.persona);
                  return (
                    <div className="info-row">
                      <span className="info-k">PERSONA</span>
                      <span className="info-v">
                        {p ? p.role : agent.persona}
                        {p && p.skills.length > 0 ? ` · ${p.skills.join(", ")}` : ""}
                      </span>
                    </div>
                  );
                })()}
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
    </ModalBackdrop>
    {pickSprite && <SpritePicker agent={agent} onClose={() => setPickSprite(false)} />}
    </>
  );
}
