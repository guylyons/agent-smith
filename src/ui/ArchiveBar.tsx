import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Card } from "../lib/board";
import type { ArchivedCard } from "../lib/archive";
import { archiveColumnAction, fetchArchive, unarchiveCardAction, unarchiveCardsAction } from "./actions";
import { ArchivedCardModal } from "./ArchivedCardModal";
import { archiveFilterNote, archivePrompt, archivedToast, focusAfterRestore } from "./archiveView";
import { filterCards, type RepoFilter } from "./repoFilter";
import { toast } from "./toast";

// Under the Merged column's head: ARCHIVE takes the cards shown (so, under a
// repo filter, only that repo's) off the board into .line-archive.json (see
// src/lib/archive.ts), after asking, with an UNDO that puts the batch back.
// ARCHIVED (n) lists what's there: each row opens the card read-only, with a
// RESTORE. Focus is steered to a neighbour whenever the control it was on
// goes away, so a keyboard user stays in the column.
export function ArchiveBar({ columnId, shown, filter, archived }: {
  columnId: string;
  /** the column's cards the view shows: what ARCHIVE archives */
  shown: Card[];
  filter: RepoFilter;
  archived: number;
}) {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<ArchivedCard[] | "error" | null>(null);
  const [reload, setReload] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  // Controls to focus once one of them is on screen, in order of preference
  // ("archive", "toggle", "row:<id>"); some only appear after the next snapshot.
  const [focusWant, setFocusWant] = useState<string[] | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Refetch while open whenever the count moves (an archive or a restore).
  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchArchive().then((c) => { if (live) setCards(c ?? "error"); });
    return () => { live = false; };
  }, [open, archived, reload]);

  useLayoutEffect(() => {
    if (!focusWant) return;
    for (const key of focusWant) {
      const el = barRef.current?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
      if (el) { el.focus(); setFocusWant(null); return; }
    }
  });
  // Give up on a target that never shows (the snapshot didn't bring it).
  useEffect(() => {
    if (!focusWant) return;
    const t = setTimeout(() => setFocusWant(null), 3000);
    return () => clearTimeout(t);
  }, [focusWant]);

  const list = Array.isArray(cards) ? filterCards(cards, filter) : [];
  const note = Array.isArray(cards) ? archiveFilterNote(list.length, cards.length) : null;
  const viewed = viewing ? list.find((k) => k.id === viewing) ?? null : null;

  async function doArchive() {
    if (busy) return;
    setBusy(true);
    const ids = await archiveColumnAction(columnId, shown.map((c) => c.id));
    setBusy(false);
    setConfirming(false);
    if (ids === null) { setFocusWant(["archive"]); return; }
    setFocusWant(["toggle", "archive"]);
    if (!ids.length) { toast(archivedToast(0)); return; }
    toast(archivedToast(ids.length), {
      label: "UNDO",
      run: () => { void unarchiveCardsAction(ids).then((ok) => { if (ok) setFocusWant(["archive", "toggle"]); }); },
    });
  }

  function cancel() {
    setConfirming(false);
    setFocusWant(["archive"]);
  }

  function restore(id: string) {
    const ids = list.map((k) => k.id);
    setViewing(null);
    setFocusWant(focusAfterRestore(ids, id));
    // Drop the row now so focus has its neighbour to go to; a failed restore
    // refetches to put it back.
    setCards((c) => (Array.isArray(c) ? c.filter((k) => k.id !== id) : c));
    void unarchiveCardAction(id).then((ok) => { if (!ok) setReload((n) => n + 1); });
  }

  return (
    <div className="archive-bar pix" ref={barRef}>
      {shown.length > 0 && !confirming && (
        <button className="archive-btn" data-focus="archive" title="Move the cards shown in this column to the archive. They can be restored." onClick={() => setConfirming(true)}>ARCHIVE</button>
      )}
      {confirming && (
        <div className="archive-confirm" role="group" aria-labelledby={`archive-q-${columnId}`}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
          <span id={`archive-q-${columnId}`} className="archive-q">{archivePrompt(shown.length, filter)}</span>
          <button className="archive-btn archive-yes" disabled={busy} onClick={() => void doArchive()}>{busy ? "ARCHIVING…" : "ARCHIVE"}</button>
          <button className="archive-btn" autoFocus disabled={busy} onClick={cancel}>CANCEL</button>
        </div>
      )}
      {archived > 0 && (
        <button className="archive-btn" data-focus="toggle" aria-expanded={open} onClick={() => setOpen(!open)}>ARCHIVED ({archived})</button>
      )}
      {open && archived > 0 && (
        <ul className="archive-list">
          {cards === null && <li>…</li>}
          {cards === "error" && (
            <li className="archive-error" role="alert">
              <span>Couldn't load the archive.</span>
              <button className="archive-btn" onClick={() => { setCards(null); setReload((n) => n + 1); }}>RETRY</button>
            </li>
          )}
          {note && <li className="archive-note">{note}</li>}
          {Array.isArray(cards) && !list.length && <li className="archive-note">No archived cards match the repo filter.</li>}
          {list.map((k) => {
            const title = k.title.trim() || "(untitled card)";
            return (
              <li key={k.id}>
                <button className="archive-title" data-focus={`row:${k.id}`} title={title} aria-label={`Open archived card "${title}"`} onClick={() => setViewing(k.id)}>{title}</button>
                <button className="archive-btn" title="Put this card back on the board" aria-label={`Restore "${title}"`} onClick={() => restore(k.id)}>RESTORE</button>
              </li>
            );
          })}
        </ul>
      )}
      {/* Portalled out of the column, whose styles would otherwise reach it. */}
      {viewed && createPortal(<ArchivedCardModal card={viewed} onRestore={() => restore(viewed.id)} onClose={() => setViewing(null)} />, document.body)}
    </div>
  );
}
