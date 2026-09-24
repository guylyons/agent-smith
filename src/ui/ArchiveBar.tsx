import { useEffect, useState } from "react";
import type { ArchivedCard } from "../lib/archive";
import { archiveColumnAction, fetchArchive, unarchiveCardAction } from "./actions";
import { toast } from "./toast";

// Under the Merged column's head: ARCHIVE takes its cards off the board (into
// .line-archive.json, see src/lib/archive.ts) so every snapshot stops carrying
// them, and ARCHIVED (n) lists what's there with a RESTORE on each. Nothing is
// lost either way, so neither asks for confirmation.
export function ArchiveBar({ columnId, cardCount, archived }: { columnId: string; cardCount: number; archived: number }) {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<ArchivedCard[] | null>(null);

  // Refetch while open whenever the count moves (an archive or a restore).
  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchArchive().then((c) => { if (live) setCards(c); });
    return () => { live = false; };
  }, [open, archived]);

  async function onArchive() {
    const n = await archiveColumnAction(columnId);
    if (n !== null) toast(n ? `Archived ${n} card${n > 1 ? "s" : ""}` : "Nothing to archive");
  }

  return (
    <div className="archive-bar pix">
      {cardCount > 0 && (
        <button className="archive-btn" title="Move this column's cards to the archive. They can be restored." onClick={onArchive}>ARCHIVE</button>
      )}
      {archived > 0 && (
        <button className="archive-btn" aria-expanded={open} onClick={() => setOpen(!open)}>ARCHIVED ({archived})</button>
      )}
      {open && archived > 0 && (
        <ul className="archive-list">
          {cards === null && <li>…</li>}
          {cards?.map((k) => (
            <li key={k.id}>
              <span className="archive-title" title={k.title}>{k.title.trim() || "(untitled card)"}</span>
              <button className="archive-btn" title="Put this card back on the board" aria-label={`Restore "${k.title.trim() || "untitled card"}"`} onClick={() => void unarchiveCardAction(k.id)}>RESTORE</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
