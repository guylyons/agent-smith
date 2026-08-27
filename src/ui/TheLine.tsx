import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Board, Column, Card } from "../lib/board";
import {
  addColumn, renameColumn, setInstruction, deleteColumn, reorderColumn,
  addCard, renameCard, deleteCard, moveCard,
} from "../lib/board";
import { updateBoard } from "./actions";

const CARD_MIME = "application/x-line-card";
const COL_MIME = "application/x-line-column";

// A board mutation: given the latest board, return the next one.
type Mutate = (fn: (b: Board) => Board) => void;

// THE LINE — a simple kanban board. Columns and cards are renamable and
// draggable; each column carries an instruction describing what to do with work
// that lands in it. The board is held in local state (seeded from the live
// snapshot); every edit applies a PURE op via a functional update — so rapid
// edits build on each other instead of clobbering — and posts the result to the
// server, which persists it and echoes it back over SSE.
export function TheLine({ board: incoming }: { board: Board }) {
  const [board, setBoard] = useState(incoming);
  const [addingCol, setAddingCol] = useState(false);

  // Adopt snapshots from the server (our own echoes, or edits from another tab
  // / an agent). Active text fields keep their own draft, so this never yanks a
  // value out from under the cursor.
  useEffect(() => { setBoard(incoming); }, [incoming]);

  const mutate: Mutate = (fn) =>
    setBoard((prev) => { const next = fn(prev); updateBoard(next); return next; });

  function onAddColumn() {
    setAddingCol(true);
    mutate((b) => addColumn(b, "")); // blank name -> its input auto-focuses
  }

  return (
    <section className="win line">
      <h2 className="pix">THE LINE</h2>
      <p className="pix hint">DRAG WORK ACROSS YOUR STAGES · EACH STAGE CAN INSTRUCT THE AGENT</p>
      <div className="board">
        {board.columns.map((col, i) => (
          <ColumnView
            key={col.id}
            board={board}
            mutate={mutate}
            column={col}
            index={i}
            autoFocusName={addingCol && i === board.columns.length - 1}
            onNamed={() => setAddingCol(false)}
          />
        ))}
        <button className="pix add-col" onClick={onAddColumn} title="Add a column">+ COLUMN</button>
      </div>
    </section>
  );
}

function ColumnView({
  board, mutate, column, index, autoFocusName, onNamed,
}: {
  board: Board; mutate: Mutate; column: Column; index: number; autoFocusName: boolean; onNamed: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const cardId = e.dataTransfer.getData(CARD_MIME);
    if (cardId) { mutate((b) => moveCard(b, cardId, column.id)); return; }
    const colId = e.dataTransfer.getData(COL_MIME);
    if (colId && colId !== column.id) mutate((b) => reorderColumn(b, colId, index));
  }

  function onDelete() {
    const n = board.cards.filter((c) => c.columnId === column.id).length;
    const label = column.name || "this column";
    const msg = n ? `Delete "${label}" and its ${n} card${n > 1 ? "s" : ""}?` : `Delete "${label}"?`;
    if (confirm(msg)) mutate((b) => deleteColumn(b, column.id));
  }

  return (
    <div
      className={`col${dragOver ? " dragover" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
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
          onCommit={(v) => { mutate((b) => renameColumn(b, column.id, v)); onNamed(); }}
        />
        <button className="col-del" title="Delete column" onClick={onDelete}>✕</button>
      </div>

      <InstructionField
        value={column.instruction}
        onCommit={(v) => mutate((b) => setInstruction(b, column.id, v))}
      />

      <div className="cards">
        {board.cards.filter((c) => c.columnId === column.id).map((card) => (
          <CardView key={card.id} mutate={mutate} card={card} />
        ))}
      </div>

      <AddCard mutate={mutate} columnId={column.id} />
    </div>
  );
}

function CardView({ mutate, card }: { mutate: Mutate; card: Card }) {
  const [editing, setEditing] = useState(false);
  return (
    <div
      className="card"
      draggable={!editing}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData(CARD_MIME, card.id); }}
    >
      <InlineText
        className="card-title"
        value={card.title}
        placeholder="Card…"
        onEditingChange={setEditing}
        onCommit={(v) => mutate((b) => renameCard(b, card.id, v))}
      />
      <button className="card-del" title="Delete card" onClick={() => mutate((b) => deleteCard(b, card.id))}>✕</button>
    </div>
  );
}

function AddCard({ mutate, columnId }: { mutate: Mutate; columnId: string }) {
  const [value, setValue] = useState("");
  function commit() {
    const t = value.trim();
    if (!t) return;
    mutate((b) => addCard(b, columnId, t));
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
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { stop(); onCommit(draft.trim()); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === "Escape") { setDraft(value); stop(); (e.target as HTMLInputElement).blur(); }
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
