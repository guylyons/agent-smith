import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { AgentStatus } from "../schema";
import type { Board, Card } from "../lib/board";
import type { Assignee } from "../lib/board";
import { renameCard, setCardDescription, assignCard, addComment, deleteComment, moveCard, cardTaskPrompt } from "../lib/board";
import {
  sendCardTask, uploadImage, ME,
  renameCardAction, setCardDescriptionAction, assignCardAction,
  addCommentAction, deleteCommentAction, moveCardAction, type Delivery,
} from "./actions";
import { ModalBackdrop } from "./Backdrop";
import { MergeKey } from "./MergeKey";
import { renderMarkdown, imageSrc } from "./markdown";
import { imagesIn, imageMarkdown, appendImage, removeImage } from "./cardImages";
import { toast } from "./toast";

// Matches TheLine's: the pure op to paint immediately, plus the one scoped
// server call that makes it real. See actions.ts for why nothing sends a board.
type Mutate = (fn: ((b: Board) => Board) | null, send: () => void) => void;

// Which field a dropped/pasted image lands in. Drops anywhere on the modal go to
// whichever field the user last touched, defaulting to the comment box — the
// common case is "here's a screenshot of the bug" on an existing ticket.
type Target = "desc" | "comment";

// A ticket's images are just markdown in the card's own text (see cardImages.ts),
// so attaching one is: upload, then append the token to that field's draft.
function useImageAttach() {
  const [busy, setBusy] = useState(false);

  /** Upload every image in `files`, in order. Non-images are ignored; a failed
   *  upload is dropped (uploadImage has already said why). */
  async function upload(files: Iterable<File>): Promise<{ name: string; path: string }[]> {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return [];
    setBusy(true);
    const ups = await Promise.all(images.map(async (f) => {
      const up = await uploadImage(f);
      return up ? { name: f.name || "image", path: up.path } : null;
    }));
    setBusy(false);
    return ups.filter((u): u is { name: string; path: string } => u !== null);
  }

  return { busy, upload };
}

/** Whether SEND TASK can fire, and if not, why — shown as the button's title.
 *  A fresh task clears the agent's context first, so it must be idle: sending
 *  into a working session would wipe its work mid-task, and into a waiting one
 *  would press keys on its dialog. */
export function sendTaskGate(assigned: Assignee | null | undefined, agents: AgentStatus[]): { enabled: boolean; reason: string } {
  if (!assigned) return { enabled: false, reason: "Assign a running agent first" };
  const live = agents.find((a) => a.sessionId === assigned.id || (!!assigned.crew && a.crew?.id === assigned.crew));
  if (!live) return { enabled: false, reason: `${assigned.name}'s session has ended - assign a running agent` };
  if (live.state === "working") return { enabled: false, reason: `${live.name} is working - wait for it to go idle (or pause it) before sending a new task` };
  if (live.state === "waiting") return { enabled: false, reason: `${live.name} is waiting on a prompt in its terminal - answer that first` };
  return { enabled: true, reason: "Send this card's task to the assigned agent" };
}

/** One line on where a posted comment went, from the server's delivery report. */
export function deliveryToast(delivery: Delivery[]): string {
  const typed = delivery.filter((d) => d.via === "typed").map((d) => d.name);
  const queued = delivery.filter((d) => d.via === "queued").map((d) => d.name);
  if (!typed.length && !queued.length) return "No running agent to notify - comment saved";
  if (!typed.length) return `Queued for ${queued.join(", ")} (busy) - lands when its turn ends`;
  const parts = [`Notified ${typed.join(", ")}`];
  if (queued.length) parts.push(`queued for ${queued.join(", ")} (busy)`);
  return parts.join("; ");
}

// A Trello-style detail view for one card, over a dimmed backdrop. Gives a
// single card room to breathe: editable title + description, an agent
// assignee, a comment thread, and images you can paste, drop, or pick.
// Backdrop click or Esc closes it.
export function CardModal({
  board, card, columnName, agents, mutate, onSpawnForCard, onClose,
}: {
  board: Board; card: Card; columnName: string; agents: AgentStatus[];
  mutate: Mutate; onSpawnForCard: (task: string, cardId: string) => void; onClose: () => void;
}) {
  // The assignee is a live agent session: its assignee.id is the sessionId. If
  // that session is no longer in the snapshot it has ended — we keep it selected
  // and labelled so the card still shows who had it.
  const assigned = card.assignee;
  // Matched by crew as well as session id: the same agent comes back under a
  // new session id after a /clear (see src/lib/crew.ts).
  const assignedAgent = assigned
    ? agents.find((a) => a.sessionId === assigned.id || (!!assigned.crew && a.crew?.id === assigned.crew))
    : undefined;
  const assignedIsLive = !!assignedAgent;
  const gate = sendTaskGate(assigned, agents);

  // Both editable texts live here rather than in the fields, so an image dropped
  // anywhere on the modal can be appended to whichever one is active.
  const [desc, setDesc] = useState(card.description ?? "");
  const [editingDesc, setEditingDesc] = useState(false);
  const [comment, setComment] = useState("");
  // A comment's images are held aside until POST rather than pasted into the
  // draft as markdown: an upload path is long enough to bury the sentence you're
  // writing. The description is the opposite case — there the markdown IS the
  // saved content, so it lives in the text.
  const [commentImgs, setCommentImgs] = useState<{ name: string; path: string }[]>([]);
  const [target, setTarget] = useState<Target>("comment");
  const [dragOver, setDragOver] = useState(false);
  const { busy: uploading, upload } = useImageAttach();
  const commentRef = useRef<HTMLTextAreaElement>(null);

  // A live snapshot echo must never yank the description out from under the
  // cursor, so only re-sync it while the field is idle.
  useEffect(() => { if (!editingDesc) setDesc(card.description ?? ""); }, [card.description, editingDesc]);

  function commitDesc(next: string) {
    setDesc(next);
    if (next !== (card.description ?? "")) {
      mutate((b) => setCardDescription(b, card.id, next), () => setCardDescriptionAction(card.id, next));
    }
  }

  // Attach images to `to`, or to whichever field was last touched.
  async function attach(files: Iterable<File>, to: Target = target) {
    const ups = await upload(files);
    if (!ups.length) return;
    if (to === "comment") {
      setCommentImgs((list) => [...list, ...ups]);
      commentRef.current?.focus();
      return;
    }
    const block = ups.map((u) => imageMarkdown(u.name, u.path)).join("\n");
    // While the description is open for editing, the draft is the truth and its
    // blur will commit it; from the resting view there's no blur coming, so the
    // append has to save itself.
    const next = appendImage(desc, block);
    if (editingDesc) setDesc(next); else commitDesc(next);
  }

  // Paste only intercepts when the clipboard actually carries an image, so
  // ordinary text paste is untouched.
  function pasteInto(to: Target) {
    return (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files?.length && [...files].some((f) => f.type.startsWith("image/"))) {
        e.preventDefault();
        void attach(files, to);
      }
    };
  }

  // Send the card's task to the assigned live agent. The server composes the
  // prompt (task + board protocol footer), types it into the session, and drops
  // the "Sent task to …" trace comment, which echoes back over SSE.
  function sendToAssigned() {
    if (!assigned) return;
    void sendCardTask(card.id, assigned.id).then((ok) => { if (ok) toast(`Sent to ${assigned.name}`); });
  }

  // Post a comment. The SERVER delivers it to whoever is on the card — the
  // assignee, any scrum master — typed in if they are idle, queued for their
  // turn to end if not; it reports which, and that is what the toast says.
  // (This used to also type the note in from here, so every comment arrived
  // twice, in two wordings.)
  function postComment(text: string) {
    mutate(
      (b) => addComment(b, card.id, ME, text),
      () => { void addCommentAction(card.id, text).then((delivery) => toast(deliveryToast(delivery))); },
    );
  }

  // What POST actually sends: the typed note, then each attached image on its
  // own line. Either half alone is a valid comment — a screenshot with no words
  // is often the whole point.
  const commentBody = [comment.trim(), ...commentImgs.map((i) => imageMarkdown(i.name, i.path))]
    .filter(Boolean).join("\n\n");

  function post() {
    if (!commentBody) return;
    postComment(commentBody);
    setComment("");
    setCommentImgs([]);
    commentRef.current?.focus();
  }

  // Spawn a fresh agent seeded with this card's task (persona/model/worktree
  // chosen in the New Agent modal). Closes the card so the modal is unobstructed.
  function spawnForCard() {
    onSpawnForCard(cardTaskPrompt(board, card.id, location.origin), card.id);
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
      <div
        className={`win cardmodal${dragOver ? " drag-over" : ""}`}
        onDragOver={(e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e: DragEvent) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e: DragEvent) => {
          const files = e.dataTransfer?.files;
          if (files?.length) { e.preventDefault(); void attach(files); }
          setDragOver(false);
        }}
      >
        <div className="cardmodal-head">
          <span className="pix cardmodal-crumb">IN {columnName || "—"}</span>
          <button className="cardmodal-x" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="cardmodal-body">
          <TitleField
            value={card.title}
            onCommit={(v) => { if (v) mutate((b) => renameCard(b, card.id, v), () => renameCardAction(card.id, v)); }}
          />

          {/* Dragging is the fast way to re-stage a card, but it is mouse-only:
              on a touch screen HTML5 drag events never fire at all. A plain
              select is the path that works for touch, keyboard and screen
              readers alike. */}
          <div className="cardmodal-row">
            <label className="pix cardmodal-label" htmlFor="cardmodal-column">STAGE</label>
            <select
              id="cardmodal-column"
              className="cardmodal-select"
              value={card.columnId}
              onChange={(e) => {
                const to = e.target.value;
                mutate((b) => moveCard(b, card.id, to), () => moveCardAction(card.id, to));
              }}
            >
              {board.columns.map((c) => (
                <option key={c.id} value={c.id}>{c.name || "Untitled"}</option>
              ))}
            </select>
          </div>

          <div className="cardmodal-row">
            <label className="pix cardmodal-label">ASSIGNEE</label>
            <select
              className="cardmodal-select"
              value={assignedAgent?.sessionId ?? assigned?.id ?? ""}
              onChange={(e) => {
                const a = agents.find((x) => x.sessionId === e.target.value);
                mutate(
                  (b) => assignCard(b, card.id, a ? { id: a.sessionId, name: a.name, ...(a.crew ? { crew: a.crew.id } : {}) } : null),
                  () => assignCardAction(card.id, a ? a.sessionId : null),
                );
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
            {/* Notes for a busy agent wait in the server's inbox until its turn
                ends; say so, or a comment looks unanswered for no reason. */}
            {assignedAgent?.inbox ? (
              <p className="cardmodal-empty">{assignedAgent.inbox} note{assignedAgent.inbox === 1 ? "" : "s"} queued for {assignedAgent.name} - delivered when its turn ends.</p>
            ) : null}
            <div className="cardmodal-assign-actions">
              <button
                className="pix cardmodal-send"
                disabled={!gate.enabled}
                title={gate.reason}
                onClick={sendToAssigned}
              >▸ SEND TASK</button>
              <button
                className="pix cardmodal-spawn"
                title="Launch a new agent seeded with this card's task"
                onClick={spawnForCard}
              >+ NEW AGENT FOR THIS CARD</button>
            </div>
          </div>

          {/* Once the card's agent has committed work on its branch, a key
              rises here to land it. It draws itself only when there is
              something to merge, so an unfinished ticket shows nothing. */}
          <MergeKey cardId={card.id} hasAssignee={!!assigned} />

          <div className="cardmodal-row">
            <label className="pix cardmodal-label">DESCRIPTION</label>
            {/* Read first, edit on click. An attached image is a markdown token in
                this very text, and a screenshot's file path is long enough to bury
                the prose — so the resting state renders it, and the raw source only
                appears while you're actually typing in it. */}
            {editingDesc ? (
              <>
                <textarea
                  className="cardmodal-desc"
                  autoFocus
                  value={desc}
                  placeholder="Add a fuller description of this task…  (paste or drop an image)"
                  onFocus={() => setTarget("desc")}
                  onChange={(e) => setDesc(e.target.value)}
                  onPaste={pasteInto("desc")}
                  onBlur={() => { setEditingDesc(false); commitDesc(desc); }}
                />
                <ImageStrip
                  images={imagesIn(desc)}
                  onRemove={(token) => setDesc((t) => removeImage(t, token))}
                />
              </>
            ) : (
              <div
                className={`cardmodal-descview${desc.trim() ? "" : " is-empty"}`}
                role="button"
                tabIndex={0}
                title="Click to edit"
                onClick={() => { setEditingDesc(true); setTarget("desc"); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); setEditingDesc(true); setTarget("desc"); }
                }}
              >
                {desc.trim()
                  ? renderMarkdown(desc)
                  : "Add a fuller description of this task…  (paste or drop an image)"}
              </div>
            )}
            <AttachButton busy={uploading} onFiles={(f) => void attach(f, "desc")} />
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
                      onClick={() => mutate((b) => deleteComment(b, card.id, c.id), () => deleteCommentAction(card.id, c.id))}
                    >✕</button>
                  </div>
                  <div className="comment-text">{renderMarkdown(c.text)}</div>
                </div>
              ))}
              {!comments.length && <p className="cardmodal-empty">No comments yet.</p>}
            </div>

            <div className="comment-compose">
              <textarea
                ref={commentRef}
                className="comment-input"
                value={comment}
                placeholder="Write a comment…  (⌘↵ to post · paste or drop an image)"
                onFocus={() => setTarget("comment")}
                onChange={(e) => setComment(e.target.value)}
                onPaste={pasteInto("comment")}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } }}
              />
              <ImageStrip
                images={commentImgs.map((i) => ({ token: i.path, alt: i.name, src: i.path }))}
                onRemove={(path) => setCommentImgs((list) => list.filter((i) => i.path !== path))}
              />
              <div className="comment-actions">
                <AttachButton busy={uploading} onFiles={(f) => void attach(f, "comment")} />
                <button className="pix comment-post" disabled={!commentBody} onClick={post}>POST</button>
              </div>
            </div>
          </div>
        </div>
        {dragOver && <div className="cardmodal-droplabel pix">DROP IMAGE TO ATTACH</div>}
      </div>
    </ModalBackdrop>
  );
}

// Thumbnails of the images currently in a field's text, each removable. Direct
// manipulation, so nobody has to hand-edit a markdown token to drop a screenshot.
function ImageStrip({ images, onRemove }: { images: { token: string; alt: string; src: string }[]; onRemove: (token: string) => void }) {
  if (!images.length) return null;
  return (
    <div className="card-imgs">
      {images.map((img, i) => {
        const src = imageSrc(img.src);
        return (
          <span key={`${img.token}-${i}`} className="card-img" title={img.alt || img.src}>
            {src
              ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={img.alt || "attachment"} loading="lazy" /></a>
              : <span className="card-img-missing">🖼</span>}
            <button className="card-img-x" title="Remove this image" aria-label={`Remove ${img.alt || "image"}`}
              onClick={() => onRemove(img.token)}>✕</button>
          </span>
        );
      })}
    </div>
  );
}

// A real file picker, so images can be attached without a drag or a clipboard —
// and so the whole feature is reachable from the keyboard.
function AttachButton({ busy, onFiles }: { busy: boolean; onFiles: (files: FileList) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="deskbtn card-attach" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? "UPLOADING…" : "📎 ATTACH IMAGE"}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = ""; // so picking the same file twice fires again
        }}
      />
    </>
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
