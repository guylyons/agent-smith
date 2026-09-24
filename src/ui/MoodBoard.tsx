// The MOOD board view: a pannable, zoomable canvas of notes and the arrows
// between them (see src/lib/mood.ts for the model). Everything you do here is
// one scoped call (src/ui/actions.ts); the result comes back on the live
// snapshot, so an agent's new note appears the same way yours does.
//
// Mouse:    drag a note to move it · drag its ○ handle onto another note to link
//           them · drag empty canvas to pan · wheel to pan, ctrl/⌘+wheel (or a
//           pinch) to zoom · double-click empty canvas for a new note.
// Keyboard: Tab to a note · Enter edits · arrows move it (Shift = further) ·
//           L starts a link, then Enter on the target · Delete removes ·
//           + / − / 0 zoom and fit · Esc cancels.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Board } from "../lib/board";
import {
  MOOD_KINDS, NOTE_W, fitView, rectEdgePoint, zoomAt,
  type Mood, type MoodKind, type MoodLink, type MoodNote, type Rect,
} from "../lib/mood";
import {
  addMoodNoteAction, addMoodLinkAction, deleteMoodLinkAction, deleteMoodNoteAction,
  restoreMoodNoteAction, setMoodLinkLabelAction, updateMoodNoteAction,
} from "./actions";
import { renderMarkdown } from "./markdown";
import { toast } from "./toast";

type View = { x: number; y: number; z: number };
type Pt = { x: number; y: number };
type Selection = { kind: "note"; id: string } | { kind: "link"; id: string } | null;

const KIND_LABEL: Record<MoodKind, string> = {
  focus: "FOCUS", idea: "IDEA", risk: "RISK", question: "QUESTION", done: "LANDED", note: "NOTE", heading: "HEADING",
};
const VIEW_KEY = "agent-workshop:mood-view";
const DEFAULT_H = 96;
/** What a press on the canvas must not start a pan (or a new note) from. */
const NOT_CANVAS = "[data-note-id], .mood-link-hit, .mood-link-label";
/** A pointer that travels less than this is a click, not a drag. */
const DRAG_SLOP = 4;

function loadView(): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (v && [v.x, v.y, v.z].every((n) => typeof n === "number" && Number.isFinite(n))) return v;
  } catch { /* private window, blocked storage */ }
  return null;
}
function saveView(v: View) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

export function MoodBoard({ mood, board, onOpenCard }: { mood: Mood | undefined; board: Board; onOpenCard: (cardId: string) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(() => loadView() ?? { x: 48, y: 48, z: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => { const t = setTimeout(() => saveView(view), 250); return () => clearTimeout(t); }, [view]);

  // Where a note is being dragged to, ahead of the server confirming it.
  const [moving, setMoving] = useState<Record<string, Pt>>({});
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [selected, setSelected] = useState<Selection>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Link in progress: from which note, and where the loose end is (canvas coords;
  // null while the keyboard is choosing a target).
  const [linking, setLinking] = useState<{ from: string; to: Pt | null } | null>(null);
  const [kindForNew, setKindForNew] = useState<MoodKind>("note");

  const notes = mood?.notes ?? [];
  const links = mood?.links ?? [];

  // Drop a local position once the snapshot agrees with it.
  useEffect(() => {
    setMoving((cur) => {
      let changed = false;
      const next = { ...cur };
      for (const [id, p] of Object.entries(cur)) {
        const n = notes.find((k) => k.id === id);
        if (!n || (n.x === Math.round(p.x) && n.y === Math.round(p.y))) { delete next[id]; changed = true; }
      }
      return changed ? next : cur;
    });
  }, [mood]);

  // Selection / editing of a note that has since been deleted (by anyone).
  useEffect(() => {
    if (selected && !(selected.kind === "note" ? notes : links).some((k) => k.id === selected.id)) setSelected(null);
  }, [mood]);

  const placed = useCallback((n: MoodNote): Rect => {
    const p = moving[n.id];
    const s = sizes[n.id];
    return { x: p?.x ?? n.x, y: p?.y ?? n.y, w: s?.w ?? n.w, h: s?.h ?? DEFAULT_H };
  }, [moving, sizes]);

  // ---- measuring notes ---------------------------------------------------------
  // Heights follow the text, so links need the real box. One observer for all.
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      setSizes((cur) => {
        let next = cur;
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const id = el.dataset.noteId!;
          const w = el.offsetWidth, h = el.offsetHeight;
          if (cur[id]?.w !== w || cur[id]?.h !== h) {
            if (next === cur) next = { ...cur };
            next[id] = { w, h };
          }
        }
        return next;
      });
    });
    return () => observer.current?.disconnect();
  }, []);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) observer.current?.observe(el);
  }, []);

  // ---- coordinates -----------------------------------------------------------
  const toCanvas = useCallback((clientX: number, clientY: number): Pt => {
    const r = viewportRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.z, y: (clientY - r.top - v.y) / v.z };
  }, []);

  const zoomBy = useCallback((factor: number, at?: Pt) => {
    const el = viewportRef.current;
    if (!el) return;
    const sx = at?.x ?? el.clientWidth / 2;
    const sy = at?.y ?? el.clientHeight / 2;
    setView((v) => zoomAt(v, factor, sx, sy));
  }, []);

  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (!notes.length) { setView({ x: 48, y: 48, z: 1 }); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of notes) {
      const r = placed(n);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    setView(fitView({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, el.clientWidth, el.clientHeight));
  }, [notes, placed]);

  // First visit with nothing remembered: frame whatever is on the board, once
  // the notes have been measured.
  const framed = useRef(loadView() !== null);
  useLayoutEffect(() => {
    if (framed.current || !notes.length || Object.keys(sizes).length < notes.length) return;
    framed.current = true;
    fit();
  }, [notes, sizes, fit]);

  // Wheel: pan, or zoom with ctrl/⌘ (which is also what a trackpad pinch sends).
  // Bound by hand because React's wheel listener is passive and can't
  // preventDefault the page's own scroll/zoom.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        // A pinch sends small deltas, a mouse wheel ~100 a notch: cap the
        // step so one notch is a nudge, not a lurch to the zoom limit.
        const d = Math.max(-30, Math.min(30, e.deltaY));
        zoomBy(Math.exp(-d * 0.01), { x: e.clientX - r.left, y: e.clientY - r.top });
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  // ---- creating ---------------------------------------------------------------
  const createAt = useCallback(async (p: Pt) => {
    const id = await addMoodNoteAction({
      title: kindForNew === "heading" ? "New heading" : "New note",
      kind: kindForNew,
      x: Math.round(p.x - NOTE_W / 2),
      y: Math.round(p.y - 30),
    });
    if (id) { setSelected({ kind: "note", id }); setEditingId(id); }
  }, [kindForNew]);

  const createInView = () => {
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    void createAt(toCanvas(r.left + el.clientWidth / 2, r.top + el.clientHeight / 2));
  };

  // ---- deleting (with undo) --------------------------------------------------
  const removeNote = useCallback((note: MoodNote) => {
    const gone = links.filter((l) => l.from === note.id || l.to === note.id);
    deleteMoodNoteAction(note.id);
    setSelected(null);
    setEditingId(null);
    toast(`Removed "${note.title || "note"}"`, { label: "UNDO", run: () => restoreMoodNoteAction(note, gone) });
  }, [links]);

  const removeLink = useCallback((link: MoodLink) => {
    deleteMoodLinkAction(link.id);
    setSelected(null);
    toast("Removed the link", { label: "UNDO", run: () => { void addMoodLinkAction(link.from, link.to, link.label); } });
  }, []);

  const finishLink = useCallback(async (from: string, to: string) => {
    setLinking(null);
    if (from === to) return;
    await addMoodLinkAction(from, to);
  }, []);

  // ---- pointer: pan the canvas, drag a note, draw a link --------------------
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; view: View; moved: boolean; pointer: number }
    | { kind: "note"; id: string; start: Pt; origin: Pt; moved: boolean; pointer: number }
    | { kind: "link"; from: string }
    | null
  >(null);

  const onViewportPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(NOT_CANVAS)) return;
    gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, view, moved: false, pointer: e.pointerId };
  };

  const onNotePointerDown = (e: React.PointerEvent, n: MoodNote) => {
    if (e.button !== 0 || editingId === n.id) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    e.stopPropagation();
    const r = placed(n);
    gesture.current = { kind: "note", id: n.id, start: toCanvas(e.clientX, e.clientY), origin: { x: r.x, y: r.y }, moved: false, pointer: e.pointerId };
  };

  const onHandlePointerDown = (e: React.PointerEvent, n: MoodNote) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    gesture.current = { kind: "link", from: n.id };
    setLinking({ from: n.id, to: toCanvas(e.clientX, e.clientY) });
    viewportRef.current?.setPointerCapture(e.pointerId);
  };

  // Capture the pointer only once a press turns into a drag: capturing on the
  // press would retarget the click and double-click a plain press produces.
  const startDrag = (g: { moved: boolean; pointer: number }) => {
    g.moved = true;
    try { viewportRef.current?.setPointerCapture(g.pointer); } catch { /* pointer already gone */ }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!g.moved) startDrag(g);
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
    } else if (g.kind === "note") {
      const p = toCanvas(e.clientX, e.clientY);
      const dx = p.x - g.start.x, dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) * viewRef.current.z < DRAG_SLOP) return;
      if (!g.moved) startDrag(g);
      setMoving((m) => ({ ...m, [g.id]: { x: g.origin.x + dx, y: g.origin.y + dy } }));
    } else {
      setLinking({ from: g.from, to: toCanvas(e.clientX, e.clientY) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "pan") {
      if (!g.moved) { setSelected(null); setEditingId(null); }
    } else if (g.kind === "note") {
      setSelected({ kind: "note", id: g.id });
      // A click on a note while a link waits for its other end completes it.
      if (!g.moved && linking && linking.to === null) { void finishLink(linking.from, g.id); return; }
      if (g.moved) {
        const p = moving[g.id];
        if (p) updateMoodNoteAction(g.id, { x: Math.round(p.x), y: Math.round(p.y), raise: true });
      }
    } else {
      // Released over a note? The captured pointer means the event target is
      // the viewport, so ask the document what is under it.
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-note-id]");
      const to = hit?.dataset.noteId;
      if (to && to !== g.from) void finishLink(g.from, to);
      else setLinking(null);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(NOT_CANVAS)) return;
    void createAt(toCanvas(e.clientX, e.clientY));
  };

  // ---- keyboard -------------------------------------------------------------
  const nudge = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const onNoteKeyDown = (e: React.KeyboardEvent, n: MoodNote) => {
    if (editingId === n.id || e.target !== e.currentTarget) return;
    if (linking && linking.to === null && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      void finishLink(linking.from, n.id);
      return;
    }
    const step = e.shiftKey ? 50 : 10;
    const arrows: Record<string, Pt> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    const d = arrows[e.key];
    if (d) {
      e.preventDefault();
      const r = placed(n);
      const p = { x: r.x + d.x, y: r.y + d.y };
      setMoving((m) => ({ ...m, [n.id]: p }));
      // One write when the key stops, not one per repeat.
      clearTimeout(nudge.current[n.id]);
      nudge.current[n.id] = setTimeout(() => updateMoodNoteAction(n.id, { x: p.x, y: p.y }), 300);
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); setEditingId(n.id); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeNote(n); return; }
    if (e.key === "l" || e.key === "L") {
      e.preventDefault();
      setLinking({ from: n.id, to: null });
      toast("Linking: Tab to the other note and press Enter (Esc cancels).");
    }
  };

  const onBoardKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select")) return;
    if (e.key === "Escape") { setLinking(null); setEditingId(null); setSelected(null); return; }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.2); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.2); }
    else if (e.key === "0") { e.preventDefault(); fit(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && selected?.kind === "link") {
      const l = links.find((k) => k.id === selected.id);
      if (l) { e.preventDefault(); removeLink(l); }
    }
  };

  // ---- rendering ----------------------------------------------------------------
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const cardTitle = (id: string) => board.cards.find((k) => k.id === id)?.title;

  const linkGeom = (l: MoodLink) => {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b) return null;
    const ra = placed(a), rb = placed(b);
    const p1 = rectEdgePoint(ra, rb.x + rb.w / 2, rb.y + rb.h / 2);
    const p2 = rectEdgePoint(rb, ra.x + ra.w / 2, ra.y + ra.h / 2);
    return { p1, p2, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
  };

  const loose = linking?.to && byId.get(linking.from)
    ? (() => {
        const r = placed(byId.get(linking.from)!);
        return { p1: rectEdgePoint(r, linking.to!.x, linking.to!.y), p2: linking.to! };
      })()
    : null;

  const zoomPct = Math.round(view.z * 100);
  const selectedLink = selected?.kind === "link" ? links.find((l) => l.id === selected.id) : undefined;

  return (
    <section className="win mood" onKeyDown={onBoardKeyDown}>
      <div className="mood-bar">
        <div className="mood-head">
          <h2 className="pix">MOOD BOARD</h2>
          <p className="pix hint">THE BIG PICTURE · DRAG NOTES · DRAG ○ TO LINK · DOUBLE-CLICK TO ADD · ⌘/CTRL+WHEEL TO ZOOM</p>
        </div>
        <div className="mood-tools">
          <select aria-label="Kind of new note" value={kindForNew} onChange={(e) => setKindForNew(e.target.value as MoodKind)} className={`mood-kind-select k-${kindForNew}`}>
              {MOOD_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <button className="newagent-btn" onClick={createInView} disabled={!mood}>+ NOTE</button>
          <span className="mood-zoom" role="group" aria-label="Zoom">
            <button className="newagent-btn quiet-btn" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)">−</button>
            <button className="newagent-btn quiet-btn mood-zoom-pct" onClick={() => setView((v) => zoomAt(v, 1 / v.z, (viewportRef.current?.clientWidth ?? 0) / 2, (viewportRef.current?.clientHeight ?? 0) / 2))} title="Reset to 100%">{zoomPct}%</button>
            <button className="newagent-btn quiet-btn" onClick={() => zoomBy(1.2)} aria-label="Zoom in" title="Zoom in (+)">+</button>
            <button className="newagent-btn quiet-btn" onClick={fit} title="Fit everything in view (0)">FIT</button>
          </span>
        </div>
      </div>

      {selectedLink && (
        <LinkEditor key={selectedLink.id} link={selectedLink} onDelete={() => removeLink(selectedLink)} />
      )}
      {linking && linking.to === null && (
        <p className="pix mood-linking" role="status">
          LINKING FROM "{byId.get(linking.from)?.title}" — TAB TO A NOTE AND PRESS ENTER · ESC CANCELS
        </p>
      )}

      <div
        ref={viewportRef}
        className={`mood-viewport${linking ? " is-linking" : ""}`}
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${24 * view.z}px ${24 * view.z}px`,
        }}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { gesture.current = null; setLinking(null); }}
        onDoubleClick={onDoubleClick}
      >
        {!mood && <p className="pix mood-empty">LOADING THE BOARD…</p>}
        {mood && !notes.length && (
          <div className="mood-empty">
            <p className="pix">NOTHING ON THE BOARD YET</p>
            <p>Double-click anywhere to add a note, or ask an agent to use <code>mood_note_add</code>.</p>
          </div>
        )}
        <div className="mood-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="mood-links" aria-hidden="true">
            <defs>
              <marker id="mood-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" />
              </marker>
            </defs>
            {links.map((l) => {
              const g = linkGeom(l);
              if (!g) return null;
              const on = selected?.kind === "link" && selected.id === l.id;
              return (
                <g key={l.id} className={`mood-link${on ? " sel" : ""}`}>
                  <line x1={g.p1.x} y1={g.p1.y} x2={g.p2.x} y2={g.p2.y} markerEnd="url(#mood-arrow)" />
                  <line
                    className="mood-link-hit"
                    x1={g.p1.x} y1={g.p1.y} x2={g.p2.x} y2={g.p2.y}
                    onPointerDown={(e) => { e.stopPropagation(); setSelected({ kind: "link", id: l.id }); }}
                  />
                </g>
              );
            })}
            {loose && <line className="mood-link loose" x1={loose.p1.x} y1={loose.p1.y} x2={loose.p2.x} y2={loose.p2.y} markerEnd="url(#mood-arrow)" />}
          </svg>
          {notes.map((n) => {
            const r = placed(n);
            const isSel = selected?.kind === "note" && selected.id === n.id;
            const editing = editingId === n.id;
            const title = n.cardId ? cardTitle(n.cardId) : undefined;
            return (
              <div
                key={n.id}
                ref={measure}
                data-note-id={n.id}
                className={`mnote k-${n.kind}${isSel ? " sel" : ""}${moving[n.id] ? " dragging" : ""}${linking?.from === n.id ? " link-from" : ""}`}
                style={{ left: r.x, top: r.y, width: n.w }}
                tabIndex={0}
                role="group"
                aria-label={`${KIND_LABEL[n.kind]}: ${n.title}`}
                onPointerDown={(e) => onNotePointerDown(e, n)}
                onDoubleClick={(e) => { e.stopPropagation(); setEditingId(n.id); }}
                onKeyDown={(e) => onNoteKeyDown(e, n)}
                onFocus={() => setSelected({ kind: "note", id: n.id })}
              >
                {editing ? (
                  <NoteEditor note={n} board={board} onDone={() => setEditingId(null)} onDelete={() => removeNote(n)} />
                ) : (
                  <>
                    {n.kind !== "heading" && <div className="mnote-kind pix">{KIND_LABEL[n.kind]}</div>}
                    <div className="mnote-title">{n.title}</div>
                    {n.body && n.kind !== "heading" && <div className="mnote-body">{renderMarkdown(n.body)}</div>}
                    {n.cardId && (
                      <button className="mnote-card" onClick={() => onOpenCard(n.cardId!)} title="Open this card on THE LINE">
                        ↗ {title ?? "card no longer on the board"}
                      </button>
                    )}
                    {n.by && n.kind !== "heading" && <div className="mnote-by">— {n.by}</div>}
                    <button
                      className="mnote-handle"
                      aria-label={`Link "${n.title}" to another note`}
                      title="Drag onto another note to link them"
                      onPointerDown={(e) => onHandlePointerDown(e, n)}
                      onClick={() => { if (!gesture.current) setLinking({ from: n.id, to: null }); }}
                    />
                  </>
                )}
              </div>
            );
          })}
          {/* Labels go over the notes: two notes close together would
              otherwise hide the label of the link between them. */}
          {links.map((l) => {
            const g = linkGeom(l);
            if (!g || !l.label) return null;
            return (
              <button
                key={l.id}
                className={`mood-link-label${selected?.kind === "link" && selected.id === l.id ? " sel" : ""}`}
                style={{ left: g.mid.x, top: g.mid.y }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setSelected({ kind: "link", id: l.id })}
              >
                {l.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Inline editing inside the note itself: title, body, kind, and which LINE
 *  card it is about. Saves each field as it is committed. */
function NoteEditor({ note, board, onDone, onDelete }: { note: MoodNote; board: Board; onDone: () => void; onDelete: () => void }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body ?? "");
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); titleRef.current?.select(); }, []);

  const commit = () => {
    const patch: { title?: string; body?: string } = {};
    if (title.trim() && title.trim() !== note.title) patch.title = title.trim();
    if (body !== (note.body ?? "")) patch.body = body;
    if (Object.keys(patch).length) updateMoodNoteAction(note.id, patch);
  };
  const done = () => { commit(); onDone(); };
  const cards = board.cards;

  return (
    <div
      className="mnote-edit"
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); done(); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(); }
      }}
    >
      <input
        aria-label="Title" id={`t-${note.id}`}
        ref={titleRef}
        className="reply-input mnote-edit-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); done(); } }}
        placeholder="Headline"
      />
      {note.kind !== "heading" && (
        <>
          <textarea
            aria-label="Detail" id={`b-${note.id}`}
            className="reply-input mnote-edit-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Detail (optional, markdown)"
            rows={3}
          />
        </>
      )}
      <div className="mnote-edit-row">
        <select aria-label="Kind" id={`k-${note.id}`} className={`mood-kind-select k-${note.kind}`} value={note.kind} onChange={(e) => updateMoodNoteAction(note.id, { kind: e.target.value as MoodKind })}>
          {MOOD_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="About card" id={`c-${note.id}`} className="mood-card-select" value={note.cardId ?? ""} onChange={(e) => updateMoodNoteAction(note.id, { cardId: e.target.value || null })}>
          <option value="">No card</option>
          {cards.map((k) => <option key={k.id} value={k.id}>{k.title.slice(0, 50) || k.id}</option>)}
          {note.cardId && !cards.some((k) => k.id === note.cardId) && <option value={note.cardId}>{note.cardId} (gone)</option>}
        </select>
      </div>
      <div className="mnote-edit-row">
        <button className="newagent-btn" onClick={done}>DONE</button>
        <button className="newagent-btn quiet-btn mnote-del" onClick={onDelete}>DELETE</button>
      </div>
    </div>
  );
}

/** The selected link's label and delete, pinned above the canvas so it never
 *  scales with the zoom. */
function LinkEditor({ link, onDelete }: { link: MoodLink; onDelete: () => void }) {
  const [label, setLabel] = useState(link.label ?? "");
  const commit = () => { if (label.trim() !== (link.label ?? "")) setMoodLinkLabelAction(link.id, label); };
  return (
    <div className="mood-linkbar" role="group" aria-label="Selected link">
      <span className="pix">LINK</span>
      <input
        aria-label="Link label" id={`l-${link.id}`}
        className="reply-input"
        value={label}
        maxLength={60}
        placeholder="Label, e.g. blocks"
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
      />
      <button className="newagent-btn quiet-btn mnote-del" onClick={onDelete}>DELETE LINK</button>
    </div>
  );
}
