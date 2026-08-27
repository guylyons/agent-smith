import { useState } from "react";
import type { DragEvent } from "react";
import type { LineStage, LineItem, LineStageName } from "../lib/snapshot";
import { setLineStage } from "./actions";

const STAGES: { key: LineStageName; label: string }[] = [
  { key: "backlog", label: "BACKLOG" },
  { key: "working", label: "WORKING" },
  { key: "needs", label: "NEEDS YOU" },
  { key: "done", label: "DONE" },
  { key: "review", label: "REVIEW" },
  { key: "merged", label: "MERGED" },
];

// Columns you control by hand. Their crates drag; they accept drops. The other
// three (backlog/working/needs) are derived from live sessions, so they don't.
const DESIGNABLE: ReadonlySet<LineStageName> = new Set(["done", "review", "merged"]);

// Cosmetic-only ownership colors, matching the mock's crate accents.
const OWNER_COLORS = ["#8fc0ff", "#d8dcf0", "#f2b134", "#4fbf6a", "#b7a8ff"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function ownerColor(label: string): string {
  return OWNER_COLORS[hash(label) % OWNER_COLORS.length]!;
}

export function TheLine({ line, onOpen }: { line: LineStage[]; onOpen: (id: string) => void }) {
  const byStage = new Map(line.map((l) => [l.stage, l.items]));
  const [dragOver, setDragOver] = useState<LineStageName | null>(null);

  function onDropTo(target: LineStageName, e: DragEvent) {
    e.preventDefault();
    setDragOver(null);
    let item: LineItem;
    try { item = JSON.parse(e.dataTransfer.getData("application/json")) as LineItem; }
    catch { return; }
    if (!item.key || item.stage === target) return;
    // "done" clears the designation server-side; review/merged pin it.
    setLineStage(item.key, target as "done" | "review" | "merged", item.label, item.sessionId);
  }

  return (
    <section className="win line">
      <h2 className="pix">THE LINE</h2>
      <p className="pix hint">WHERE EVERY TICKET IS BEFORE IT LANDS</p>
      <div className="stages">
        {STAGES.map((s) => {
          const droppable = DESIGNABLE.has(s.key);
          return (
            <div
              className={`stage${droppable ? " droppable" : ""}${dragOver === s.key ? " dragover" : ""}`}
              data-key={s.key}
              key={s.key}
              onDragOver={droppable ? (e) => { e.preventDefault(); setDragOver(s.key); } : undefined}
              onDragLeave={droppable ? () => setDragOver((d) => (d === s.key ? null : d)) : undefined}
              onDrop={droppable ? (e) => onDropTo(s.key, e) : undefined}
            >
              <div className="pix stage-head">{s.label}</div>
              <div className="slot">
                {(byStage.get(s.key) ?? []).map((t) => (
                  <Crate key={t.key} item={t} onOpen={onOpen} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="belt">
        <div className="tread"></div>
      </div>
    </section>
  );
}

function Crate({ item, onOpen }: { item: LineItem; onOpen: (id: string) => void }) {
  const canDrag = DESIGNABLE.has(item.stage);
  const canOpen = !!item.sessionId;
  const open = () => { if (item.sessionId) onOpen(item.sessionId); };
  return (
    <div
      className={`crate${canDrag ? " draggable" : ""}${canOpen ? " clickable" : ""}`}
      data-num={item.label}
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      title={canDrag ? "Click to open · drag to DONE / REVIEW / MERGED" : canOpen ? "Click to open this item" : undefined}
      draggable={canDrag}
      onDragStart={canDrag ? (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/json", JSON.stringify(item));
      } : undefined}
      onClick={open}
      onKeyDown={(e) => { if (canOpen && e.key === "Enter") open(); }}
    >
      <div className="pix num">{item.label}</div>
      <div className="own" style={{ background: ownerColor(item.label) }}></div>
    </div>
  );
}
