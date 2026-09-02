import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, RefObject } from "react";
import type { AgentStatus } from "../schema";
import type { Board, Column, Card, Stage } from "../lib/board";
import {
  renameColumn, setInstruction, setColumnStage, deleteColumn, reorderColumn,
  deleteCard, restoreCard, moveCard, restoreColumn, cardMoveTarget, STAGES,
} from "../lib/board";
import {
  addColumnAction, renameColumnAction, setInstructionAction, setColumnStageAction, deleteColumnAction,
  reorderColumnAction, restoreColumnAction, addCardAction, moveCardAction,
  deleteCardAction, restoreCardAction, ME,
} from "./actions";
import { toast } from "./toast";
import { onOpenCard } from "./nav";
import { CardModal } from "./CardModal";
import { Sprite } from "./Sprite";
import { stackMaxHeight } from "./stackCap";
import { displayState } from "../lib/liveness";
import {
  canPrime, loadMarks, markCardRead, newestCommentAt, primeMarks, saveMarks,
  unreadCommentCount,
} from "./cardUnread";

const CARD_MIME = "application/x-line-card";
const COL_MIME = "application/x-line-column";

// A board edit: the pure op to show immediately, and the one scoped server call
// that makes it real. `send` is optional — an op whose id the SERVER generates
// (adding a card or a column) has nothing to show optimistically and passes the
// call alone, letting the SSE echo bring the new thing back.
type Mutate = (fn: ((b: Board) => Board) | null, send: () => void) => void;

// THE LINE — a simple kanban board. Columns and cards are renamable and
// draggable; each column carries an instruction describing what to do with work
// that lands in it. The board is held in local state (seeded from the live
// snapshot) so an edit paints instantly, but what goes to the server is one
// SCOPED call naming just that edit — never the whole board. The server applies
// it against a fresh read and echoes the result back over SSE, so a rename here
// and an agent's comment there compose instead of overwriting each other.
export function TheLine({
  board: incoming, agents, lineRows, onSpawnForCard,
}: {
  board: Board; agents: AgentStatus[]; lineRows: number;
  onSpawnForCard: (task: string, cardId: string) => void;
}) {
  const [board, setBoard] = useState(incoming);
  const [addingCol, setAddingCol] = useState(false);
  const [openCardId, setOpenCardId] = useState<string | null>(null);

  // Adopt snapshots from the server (our own echoes, or edits from another tab
  // / an agent). Active text fields keep their own draft, so this never yanks a
  // value out from under the cursor.
  useEffect(() => { setBoard(incoming); }, [incoming]);

  // Open a card when the notification center asks (clicking a comment/move).
  useEffect(() => onOpenCard(setOpenCardId), []);

  // Which comment threads you haven't read, and whether a baseline has ever
  // been taken. A browser with no baseline takes one from the first REAL board
  // it sees rather than flagging every card that was ever commented on — the
  // same "don't badge the world on first paint" rule the desks' unread badges
  // follow (src/ui/unread.ts). Not at mount: the board this first renders is
  // the empty default, and a baseline taken from that silences nothing.
  const [read, setRead] = useState(loadMarks);

  const mutate: Mutate = (fn, send) => {
    if (fn) setBoard((prev) => fn(prev));
    send();
  };

  function onAddColumn() {
    setAddingCol(true);
    mutate(null, () => addColumnAction("")); // blank name -> its input auto-focuses
  }

  // The card behind an open modal, resolved fresh each render so live edits (and
  // SSE echoes) flow in. If it's deleted while open, the modal closes itself.
  const openCard = openCardId ? board.cards.find((c) => c.id === openCardId) ?? null : null;
  const openColumn = openCard ? board.columns.find((c) => c.id === openCard.columnId) : undefined;

  useEffect(() => {
    if (read.primed || !canPrime(board.cards)) return;
    setRead({ marks: primeMarks(board.cards), primed: true });
  }, [read.primed, board.cards]);

  // Having the card open IS reading it: mark the thread as it stands now, and
  // again whenever a comment lands while you're looking at it, so a card you
  // are staring at never comes back unread the moment you close it. Guarded on
  // the mark it would write, or setting state on every SSE echo would spin.
  const openNewest = openCard ? newestCommentAt(openCard) : 0;
  useEffect(() => {
    if (!openCard) return;
    setRead((r) => (r.marks[openCard.id] === openNewest ? r : { ...r, marks: markCardRead(r.marks, openCard) }));
  }, [openCardId, openNewest]);

  // Persist, dropping marks for cards that no longer exist. Only once a real
  // baseline exists — storing the empty one would count as "primed" on the next
  // load and light up the whole board.
  useEffect(() => {
    if (read.primed) saveMarks(read.marks, board.cards);
  }, [read, board.cards]);

  const unreadOn = (card: Card) => unreadCommentCount(card, read.marks, ME);

  return (
    <section className="win line">
      <h2 className="pix">THE LINE</h2>
      <p className="pix hint">DRAG WORK ACROSS YOUR STAGES · CLICK A CARD TO OPEN IT · EACH STAGE CAN INSTRUCT THE AGENT</p>
      <div className="board">
        {board.columns.map((col, i) => (
          <ColumnView
            key={col.id}
            board={board}
            agents={agents}
            mutate={mutate}
            column={col}
            index={i}
            rows={lineRows}
            autoFocusName={addingCol && i === board.columns.length - 1}
            onNamed={() => setAddingCol(false)}
            onOpenCard={setOpenCardId}
            unreadOn={unreadOn}
          />
        ))}
        <button className="pix add-col" onClick={onAddColumn} title="Add a column">+ COLUMN</button>
      </div>

      {openCard && (
        <CardModal
          board={board}
          card={openCard}
          columnName={openColumn?.name ?? ""}
          agents={agents}
          mutate={mutate}
          onSpawnForCard={onSpawnForCard}
          onClose={() => setOpenCardId(null)}
        />
      )}
    </section>
  );
}

function ColumnView({
  board, agents, mutate, column, index, rows, autoFocusName, onNamed, onOpenCard, unreadOn,
}: {
  board: Board; agents: AgentStatus[]; mutate: Mutate; column: Column; index: number;
  rows: number; autoFocusName: boolean;
  onNamed: () => void; onOpenCard: (id: string) => void;
  /** unread comments on a card — computed by TheLine, which owns the read marks */
  unreadOn: (card: Card) => number;
}) {
  const [dragOver, setDragOver] = useState(false);
  // Which slot a dropped card would take in this column: 0 = above the first
  // card, cards.length = below the last. Null while nothing is hovering, which
  // also means "append" for a drop on the column's empty space.
  const [dropAt, setDropAt] = useState<number | null>(null);
  const cards = board.cards.filter((c) => c.columnId === column.id);
  const listRef = useRef<HTMLDivElement>(null);
  useStackCap(listRef, rows, cards.length);

  function clearDrag() { setDragOver(false); setDropAt(null); }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const at = dropAt;
    clearDrag();
    const cardId = e.dataTransfer.getData(CARD_MIME);
    if (cardId) {
      // A drop straight onto the column (not onto a card) appends, as before.
      const to = at ?? undefined;
      mutate((b) => moveCard(b, cardId, column.id, to), () => moveCardAction(cardId, column.id, to));
      return;
    }
    const colId = e.dataTransfer.getData(COL_MIME);
    if (colId && colId !== column.id) {
      mutate((b) => reorderColumn(b, colId, index), () => reorderColumnAction(colId, index));
    }
  }

  // Move a card with the keyboard. Drag-and-drop is mouse-only, so without this
  // there is no way to reorder or re-stage a card without a pointer.
  function moveByKey(cardId: string, dir: "left" | "right" | "up" | "down") {
    const t = cardMoveTarget(board, cardId, dir);
    if (!t) return;
    mutate(
      (b) => moveCard(b, cardId, t.toColumnId, t.toIndex),
      () => moveCardAction(cardId, t.toColumnId, t.toIndex),
    );
  }

  function onDelete() {
    // The server replaces an empty board with the default one, which then echoes
    // back over SSE — so deleting the last column would silently resurrect the
    // stock columns. Refuse it and say why rather than surprise the user.
    if (board.columns.length <= 1) {
      toast("Keep at least one column — an empty board resets to the default.");
      return;
    }
    // Same bargain as a card: do it, then offer it back. restoreColumn returns
    // the column to its index with the cards that went down with it.
    const doomed = board.cards.filter((c) => c.columnId === column.id);
    const label = column.name || "this column";
    const n = doomed.length;
    mutate((b) => deleteColumn(b, column.id), () => deleteColumnAction(column.id));
    toast(
      n ? `Deleted "${label}" and its ${n} card${n > 1 ? "s" : ""}` : `Deleted "${label}"`,
      {
        label: "UNDO",
        run: () => mutate(
          (b) => restoreColumn(b, column, index, doomed),
          () => restoreColumnAction(column, index, doomed),
        ),
      },
    );
  }

  return (
    <div
      className={`col${dragOver ? " dragover" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={clearDrag}
      onDrop={onDrop}
    >
      <div className="col-head">
        <span
          className="grip pix"
          title="Drag to reorder this column"
          draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData(COL_MIME, column.id); }}
        >⠿</span>
        <InlineText
          className="col-name pix"
          value={column.name}
          placeholder="Name…"
          autoFocus={autoFocusName}
          onCommit={(v) => {
            mutate((b) => renameColumn(b, column.id, v), () => renameColumnAction(column.id, v));
            onNamed();
          }}
        />
        {/* What this column MEANS to an agent's protocol: where new work waits,
            where it is worked, where it lands for review, where it is finished.
            The task footer keys off these, not the column order, so a Triage
            or Merged column can sit anywhere without confusing anyone. */}
        <select
          className="col-stage"
          value={column.stage ?? ""}
          title="Stage: what this column means to an agent (todo, doing, review, done)"
          aria-label={`Stage of column "${column.name || "Untitled"}"`}
          onChange={(e) => {
            const v = e.target.value;
            const stage = (STAGES as readonly string[]).includes(v) ? (v as Stage) : null;
            mutate((b) => setColumnStage(b, column.id, stage), () => setColumnStageAction(column.id, stage));
          }}
        >
          <option value="">-</option>
          {STAGES.map((st) => <option key={st} value={st}>{st.toUpperCase()}</option>)}
        </select>
        <button
          className="col-del"
          title="Delete column"
          aria-label={`Delete column "${column.name || "Untitled"}"`}
          onClick={onDelete}
        >✕</button>
      </div>

      <InstructionField
        value={column.instruction}
        onCommit={(v) => mutate((b) => setInstruction(b, column.id, v), () => setInstructionAction(column.id, v))}
      />

      <div className="cards" ref={listRef} onDragOver={edgeScroll}>
        {cards.map((card, i) => (
          <CardView
            key={card.id}
            agents={agents}
            mutate={mutate}
            card={card}
            index={i}
            dropBefore={dropAt === i}
            dropAfterLast={dropAt === cards.length && i === cards.length - 1}
            // Top half of a card means "above it", bottom half "below it" — the
            // insertion line follows the pointer instead of always appending.
            onDragOverCard={(before) => setDropAt(before ? i : i + 1)}
            onMoveByKey={(dir) => moveByKey(card.id, dir)}
            onOpen={() => onOpenCard(card.id)}
            unread={unreadOn(card)}
          />
        ))}
      </div>

      <AddCard mutate={mutate} columnId={column.id} />
    </div>
  );
}

const PEEK = 10; // px of the next card left showing, so the cut reads as scrollable

// Cap a column's card stack at `rows` cards and let the rest scroll. The cut is
// measured from the real card faces (they vary in height) and re-measured when
// one of them changes size — a title rewrapping, the column narrowing, a meta
// row appearing. `max-height` is set on the element rather than through React so
// nothing re-renders on a resize; `data-capped` is what the stylesheet hangs the
// scrolling off, so an uncapped column looks exactly as it did before.
function useStackCap(ref: RefObject<HTMLDivElement | null>, rows: number, count: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = () => {
      const kids = Array.from(el.children) as HTMLElement[];
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.rowGap) || 0;
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const max = stackMaxHeight(
        kids.map((k) => k.getBoundingClientRect().height), rows, gap, pad, PEEK,
      );
      el.style.maxHeight = max == null ? "" : `${max}px`;
      if (max == null) delete el.dataset.capped;
      else el.dataset.capped = "1";
    };

    apply();
    if (typeof ResizeObserver === "undefined") return;
    // Observing the cards, not the list: the list's own height is what we're
    // setting, so watching it would be a loop.
    const ro = new ResizeObserver(apply);
    for (const k of Array.from(el.children)) ro.observe(k);
    return () => ro.disconnect();
  }, [ref, rows, count]);
}

// A capped stack scrolls, and HTML drag-and-drop won't scroll it for you: a card
// dragged to the bottom edge would have nowhere to go. Nudge the list while the
// pointer sits in the last/first few pixels of it.
const EDGE = 26;
const NUDGE = 14;
function edgeScroll(e: DragEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  if (el.scrollHeight <= el.clientHeight) return;
  const r = el.getBoundingClientRect();
  if (e.clientY > r.bottom - EDGE) el.scrollTop += NUDGE;
  else if (e.clientY < r.top + EDGE) el.scrollTop -= NUDGE;
}

// A card face: click anywhere to open the detail modal. Kept deliberately
// sparse — just the title and, only when there's something to show, a footer
// with the assignee (its agent's sprite avatar, or initials when the session has
// ended) and a comment count. Detail lives in the modal.
function CardView({
  agents, mutate, card, index, dropBefore, dropAfterLast, onDragOverCard, onMoveByKey, onOpen, unread,
}: {
  agents: AgentStatus[]; mutate: Mutate; card: Card; index: number;
  dropBefore: boolean; dropAfterLast: boolean;
  onDragOverCard: (before: boolean) => void;
  onMoveByKey: (dir: "left" | "right" | "up" | "down") => void;
  onOpen: () => void;
  /** comments on this card you haven't read — 0 when there's nothing new */
  unread: number;
}) {
  const commentCount = card.comments?.length ?? 0;
  const hasMeta = !!card.assignee || commentCount > 0 || !!card.description;
  // The live session behind the assignee, if any — gives us its sprite. A card
  // assigned to a session that has since ended falls back to initials.
  const assignedAgent = card.assignee
    ? agents.find((a) => a.sessionId === card.assignee!.id || (!!card.assignee!.crew && a.crew?.id === card.assignee!.crew))
    : undefined;
  // The sprite bobs on "working", and on a card face that bob is the ONLY thing
  // saying the agent is busy — so it has to be honest. A status file frozen
  // mid-turn (killed session, crashed window, a Stop that never came back) still
  // says "working" for the five minutes it takes to age off the board; ask
  // liveness whether anything has refreshed it lately instead of trusting it.
  const avatarState = assignedAgent ? displayState(assignedAgent, Date.now()) : "idle";

  // Deleting takes the card's whole comment thread with it, so it has to be
  // recoverable. Rather than a blocking confirm() in front of every delete
  // (which people learn to dismiss), the delete happens and the toast offers it
  // back — restoreCard puts the SAME card, comments and all, at the position it
  // held. Both halves go through mutate, so they apply to the latest board.
  function onDelete() {
    const snapshot = card;
    mutate((b) => deleteCard(b, card.id), () => deleteCardAction(card.id));
    toast(`Deleted "${card.title || "Untitled"}"`, {
      label: "UNDO",
      run: () => mutate(
        (b) => restoreCard(b, snapshot, index),
        () => restoreCardAction(snapshot, index),
      ),
    });
  }

  return (
    <div
      className={`card${dropBefore ? " drop-before" : ""}${dropAfterLast ? " drop-after" : ""}${unread ? " has-unread" : ""}`}
      role="button"
      tabIndex={0}
      draggable
      title={unread
        ? `${unread} unread comment${unread > 1 ? "s" : ""} · Enter opens · Alt+arrows move it`
        : "Enter opens · Alt+arrows move it"}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); return; }
        // Alt+arrows move the card: left/right between stages, up/down within
        // the stack. Alt keeps them clear of the browser's own arrow scrolling.
        if (!e.altKey || e.metaKey || e.ctrlKey) return;
        const dir = KEY_DIR[e.key];
        if (!dir) return;
        e.preventDefault();
        onMoveByKey(dir);
        // The board re-renders around the move, so hold focus on this card to
        // keep a run of moves going instead of dumping focus back to the body.
        // In a capped column the card can land past the fold, and refocusing an
        // element that never lost focus scrolls nothing — so bring it back into
        // view by hand, or the card you're moving disappears under you.
        const el = e.currentTarget;
        requestAnimationFrame(() => { el.focus(); el.scrollIntoView({ block: "nearest" }); });
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDragOverCard(e.clientY < r.top + r.height / 2);
      }}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData(CARD_MIME, card.id); }}
    >
      <div className="card-main">
        <span className="card-title-text">{card.title || "Untitled"}</span>
        {hasMeta && (
          <div className="card-meta">
            {card.assignee && (
              assignedAgent
                ? <span className="card-avatar" title={card.assignee.name}>
                    <Sprite sessionId={assignedAgent.sessionId} role={assignedAgent.role} name={assignedAgent.name} state={avatarState} override={assignedAgent.sprite} />
                  </span>
                : <span className="card-assignee" title={`${card.assignee.name} (session ended)`}>{initials(card.assignee.name)}</span>
            )}
            {card.description && <span className="card-flag" title="Has a description">≡</span>}
            {/* Unread turns the count into "N NEW" and colours it, so a thread
                you've already read never looks the same as one that's moved on. */}
            {commentCount > 0 && (
              unread
                ? <span className="card-flag card-flag-unread" role="status"
                        title={`${unread} unread of ${commentCount} comment${commentCount > 1 ? "s" : ""}`}>
                    💬 {unread} NEW
                  </span>
                : <span className="card-flag" title={`${commentCount} comment${commentCount > 1 ? "s" : ""}`}>💬 {commentCount}</span>
            )}
          </div>
        )}
      </div>
      <button
        className="card-del"
        title="Delete card"
        aria-label={`Delete card "${card.title || "Untitled"}"`}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >✕</button>
    </div>
  );
}

const KEY_DIR: Record<string, "left" | "right" | "up" | "down" | undefined> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
};

// First letters of the first two words, for the assignee chip (e.g. "Backend
// Dev" -> "BD"). Falls back to the first character.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const letters = parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
  return letters || "?";
}

function AddCard({ mutate, columnId }: { mutate: Mutate; columnId: string }) {
  const [value, setValue] = useState("");
  function commit() {
    const t = value.trim();
    if (!t) return;
    mutate(null, () => addCardAction(columnId, t)); // the server mints the id
    setValue("");
  }
  return (
    <input
      className="add-card"
      value={value}
      placeholder="+ add card"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      onBlur={commit}
    />
  );
}

// A single-line field that shows a live draft while focused and commits on
// blur/Enter (Escape cancels). Editing is driven by local state so a snapshot
// refresh never overwrites what you're typing.
function InlineText({
  value, placeholder, className, autoFocus, onCommit, onEditingChange,
}: {
  value: string; placeholder?: string; className?: string; autoFocus?: boolean;
  onCommit: (v: string) => void; onEditingChange?: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // Escape cancels: it calls blur(), which fires onBlur synchronously with the
  // still-edited `draft` in scope (the queued setDraft(value) hasn't rendered),
  // so committing there would persist the very text the user tried to discard.
  // This flag makes onBlur skip that one commit.
  const cancelling = useRef(false);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  function start() { setEditing(true); onEditingChange?.(true); }
  function stop() { setEditing(false); onEditingChange?.(false); }

  return (
    <input
      ref={ref}
      className={className}
      value={editing ? draft : value}
      placeholder={placeholder}
      onFocus={start}
      onBlur={() => {
        stop();
        if (cancelling.current) { cancelling.current = false; setDraft(value); return; }
        onCommit(draft.trim());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === "Escape") { cancelling.current = true; (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

// The multi-line instruction. Same commit-on-blur discipline as InlineText, but
// Enter inserts a newline (instructions are prose) and whitespace is preserved.
function InstructionField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  return (
    <textarea
      className="col-instr"
      value={editing ? draft : value}
      placeholder="Instruction for an agent working this stage — e.g. Once done, ensure the worktree is clean and committed, then report in the ticket."
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft !== value) onCommit(draft); }}
    />
  );
}
