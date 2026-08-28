import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "../schema";
import type { Board, Card } from "../lib/board";
import { renameCard, setCardDescription, assignCard, addComment, deleteComment, cardTaskPrompt, commentNotifyText } from "../lib/board";
import { sendCardTask, sendPromptTo } from "./actions";
import { ModalBackdrop } from "./Backdrop";
import { toast } from "./toast";

type Mutate = (fn: (b: Board) => Board) => void;

// The human's byline on comments they post. Agents append to .line.json with
// their own persona name, so a thread reads clearly as a human↔agent exchange.
const ME = "You";

// A Trello-style detail view for one card, over a dimmed backdrop. Gives a
// single card room to breathe: editable title + description, an agent
// assignee, and a comment thread. Backdrop click or Esc closes it.
export function CardModal({
  board, card, columnName, agents, mutate, onSpawnForCard, onClose,
}: {
  board: Board; card: Card; columnName: string; agents: AgentStatus[];
  mutate: Mutate; onSpawnForCard: (task: string) => void; onClose: () => void;
}) {
  // The assignee is a live agent session: its assignee.id is the sessionId. If
  // that session is no longer in the snapshot it has ended — we keep it selected
  // and labelled so the card still shows who had it.
  const assigned = card.assignee;
  const assignedIsLive = !!assigned && agents.some((a) => a.sessionId === assigned.id);

  // Send the card's task to the assigned live agent. The server composes the
  // prompt (task + board protocol footer), types it into the session, and drops
  // the "Sent task to …" trace comment, which echoes back over SSE.
  function sendToAssigned() {
    if (!assigned) return;
    void sendCardTask(card.id, assigned.id).then((ok) => { if (ok) toast(`Sent to ${assigned.name}`); });
  }

  // Post a comment, and — since every comment is meant for whoever's on the
  // card — deliver it to the assigned agent so it's not left waiting on a note
  // it can't see. The comment always saves; delivery only happens when the
  // assignee is a running agent, and either outcome is toasted so it's never
  // ambiguous whether the note reached anyone. A live send also pulses that
  // agent's crew card green (see sendPromptTo).
  function postComment(text: string) {
    mutate((b) => addComment(b, card.id, ME, text));
    if (assigned && assignedIsLive) {
      const msg = commentNotifyText(board, card.id, text);
      // Only claim "Notified" once the send actually succeeds — otherwise the
      // user gets a "Notified X" toast contradicted a moment later by the error
      // toast from a failed delivery.
      if (msg) {
        const name = assigned.name;
        void sendPromptTo(assigned.id, msg).then((ok) => { if (ok) toast(`Notified ${name}`); });
      }
    } else {
      toast("No running agent assigned — comment saved, not delivered");
    }
  }

  // Spawn a fresh agent seeded with this card's task (persona/model/worktree
  // chosen in the New Agent modal). Closes the card so the modal is unobstructed.
  function spawnForCard() {
    onSpawnForCard(cardTaskPrompt(board, card.id, location.origin));
    onClose();
  }

  // Esc closes from anywhere in the modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const comments = card.comments ?? [];

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="win cardmodal">
        <div className="cardmodal-head">
          <span className="pix cardmodal-crumb">IN {columnName || "—"}</span>
          <button className="cardmodal-x" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="cardmodal-body">
          <TitleField
            value={card.title}
            onCommit={(v) => { if (v) mutate((b) => renameCard(b, card.id, v)); }}
          />

          <div className="cardmodal-row">
            <label className="pix cardmodal-label">ASSIGNEE</label>
            <select
              className="cardmodal-select"
              value={assigned?.id ?? ""}
              onChange={(e) => {
                const a = agents.find((x) => x.sessionId === e.target.value);
                mutate((b) => assignCard(b, card.id, a ? { id: a.sessionId, name: a.name } : null));
              }}
            >
              <option value="">Unassigned</option>
              {/* A prior assignee whose session has ended: keep it selected/visible. */}
              {assigned && !assignedIsLive && (
                <option value={assigned.id}>{assigned.name} (ended)</option>
              )}
              {agents.map((a) => (
                <option key={a.sessionId} value={a.sessionId}>
                  {a.name} — {a.role} · {a.state}
                </option>
              ))}
            </select>
            {!agents.length && <p className="cardmodal-empty">No agents are running right now.</p>}
            <div className="cardmodal-assign-actions">
              <button
                className="pix cardmodal-send"
                disabled={!assignedIsLive}
                title={assignedIsLive ? "Send this card's task to the assigned agent" : "Assign a running agent first"}
                onClick={sendToAssigned}
              >▸ SEND TASK</button>
              <button
                className="pix cardmodal-spawn"
                title="Launch a new agent seeded with this card's task"
                onClick={spawnForCard}
              >+ NEW AGENT FOR THIS CARD</button>
            </div>
          </div>

          <div className="cardmodal-row">
            <label className="pix cardmodal-label">DESCRIPTION</label>
            <DescriptionField
              value={card.description ?? ""}
              onCommit={(v) => mutate((b) => setCardDescription(b, card.id, v))}
            />
          </div>

          <div className="cardmodal-row">
            <label className="pix cardmodal-label">COMMENTS {comments.length ? `(${comments.length})` : ""}</label>
            <div className="cardmodal-comments">
              {comments.map((c) => (
                <div key={c.id} className="comment">
                  <div className="comment-meta">
                    <span className="comment-author">{c.author}</span>
                    <span className="comment-time">{timeAgo(c.at)}</span>
                    <button
                      className="comment-del"
                      title="Delete comment"
                      onClick={() => mutate((b) => deleteComment(b, card.id, c.id))}
                    >✕</button>
                  </div>
                  <div className="comment-text">{c.text}</div>
                </div>
              ))}
              {!comments.length && <p className="cardmodal-empty">No comments yet.</p>}
            </div>
            <CommentComposer onPost={postComment} />
          </div>
        </div>
      </div>
    </ModalBackdrop>
  );
}

// A big single-line title. Local draft while focused so a live snapshot echo
// never yanks the text out from under the cursor (same discipline as the board).
function TitleField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  return (
    <input
      className="cardmodal-title"
      value={editing ? draft : value}
      placeholder="Card title…"
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); onCommit(draft.trim()); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

// Multi-line description; Enter inserts a newline, commit on blur.
function DescriptionField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  return (
    <textarea
      className="cardmodal-desc"
      value={editing ? draft : value}
      placeholder="Add a fuller description of this task…"
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft !== value) onCommit(draft); }}
    />
  );
}

// The add-comment box. Cmd/Ctrl+Enter posts (plain Enter keeps a newline, since
// comments can be multi-line); the button posts too. Clears on post.
function CommentComposer({ onPost }: { onPost: (text: string) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function post() {
    const body = text.trim();
    if (!body) return;
    onPost(body);
    setText("");
    ref.current?.focus();
  }

  return (
    <div className="comment-compose">
      <textarea
        ref={ref}
        className="comment-input"
        value={text}
        placeholder="Write a comment…  (⌘↵ to post)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } }}
      />
      <button className="pix comment-post" disabled={!text.trim()} onClick={post}>POST</button>
    </div>
  );
}

// Compact relative time for a comment timestamp ("just now", "5m", "3h", "2d");
// older than a week falls back to a local date.
function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(at).toLocaleDateString();
}
