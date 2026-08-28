import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { AgentStatus } from "../schema";
import type { Board, Column, Card } from "../lib/board";
import {
  renameColumn, setInstruction, deleteColumn, reorderColumn,
  deleteCard, restoreCard, moveCard, restoreColumn, cardMoveTarget,
} from "../lib/board";
import {
  addColumnAction, renameColumnAction, setInstructionAction, deleteColumnAction,
  reorderColumnAction, restoreColumnAction, addCardAction, moveCardAction,
  deleteCardAction, restoreCardAction,
} from "./actions";
import { toast } from "./toast";
import { onOpenCard } from "./nav";
import { CardModal } from "./CardModal";
import { Sprite } from "./Sprite";

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
  board: incoming, agents, onSpawnForCard,
}: {
  board: Board; agents: AgentStatus[]; onSpawnForCard: (task: string, cardId: string) => void;
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
            autoFocusName={addingCol && i === board.columns.length - 1}
            onNamed={() => setAddingCol(false)}
            onOpenCard={setOpenCardId}
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
  board, agents, mutate, column, index, autoFocusName, onNamed, onOpenCard,
}: {
  board: Board; agents: AgentStatus[]; mutate: Mutate; column: Column; index: number; autoFocusName: boolean;
  onNamed: () => void; onOpenCard: (id: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  // Which slot a dropped card would take in this column: 0 = above the first
  // card, cards.length = below the last. Null while nothing is hovering, which
  // also means "append" for a drop on the column's empty space.
  const [dropAt, setDropAt] = useState<number | null>(null);
  const cards = board.cards.filter((c) => c.columnId === column.id);

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

      <div className="cards">
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
          />
        ))}
      </div>

      <AddCard mutate={mutate} columnId={column.id} />
    </div>
  );
}

// A card face: click anywhere to open the detail modal. Kept deliberately
// sparse — just the title and, only when there's something to show, a footer
// with the assignee (its agent's sprite avatar, or initials when the session has
// ended) and a comment count. Detail lives in the modal.
function CardView({
  agents, mutate, card, index, dropBefore, dropAfterLast, onDragOverCard, onMoveByKey, onOpen,
}: {
  agents: AgentStatus[]; mutate: Mutate; card: Card; index: number;
  dropBefore: boolean; dropAfterLast: boolean;
  onDragOverCard: (before: boolean) => void;
  onMoveByKey: (dir: "left" | "right" | "up" | "down") => void;
  onOpen: () => void;
}) {
  const commentCount = card.comments?.length ?? 0;
  const hasMeta = !!card.assignee || commentCount > 0 || !!card.description;
  // The live session behind the assignee, if any — gives us its sprite. A card
  // assigned to a session that has since ended falls back to initials.
  const assignedAgent = card.assignee ? agents.find((a) => a.sessionId === card.assignee!.id) : undefined;

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
      className={`card${dropBefore ? " drop-before" : ""}${dropAfterLast ? " drop-after" : ""}`}
      role="button"
      tabIndex={0}
      draggable
      title="Enter opens · Alt+arrows move it"
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
        const el = e.currentTarget;
        requestAnimationFrame(() => el.focus());
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
                    <Sprite sessionId={assignedAgent.sessionId} role={assignedAgent.role} state={assignedAgent.state} override={assignedAgent.sprite} />
                  </span>
                : <span className="card-assignee" title={`${card.assignee.name} (session ended)`}>{initials(card.assignee.name)}</span>
            )}
            {card.description && <span className="card-flag" title="Has a description">≡</span>}
            {commentCount > 0 && <span className="card-flag" title={`${commentCount} comment${commentCount > 1 ? "s" : ""}`}>💬 {commentCount}</span>}
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
