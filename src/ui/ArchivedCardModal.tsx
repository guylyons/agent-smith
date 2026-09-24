import type { ArchivedCard } from "../lib/archive";
import { ModalBackdrop } from "./Backdrop";
import { timeAgo } from "./CardModal";
import { renderMarkdown } from "./markdown";
import { cardRef } from "../lib/ticket";

// An archived card, read-only: the same head and body as CardModal, with none
// of its editing. The one action is RESTORE, which puts it back on the board
// (where it can be edited again).
export function ArchivedCardModal({ card, onRestore, onClose }: {
  card: ArchivedCard; onRestore: () => void; onClose: () => void;
}) {
  const comments = card.comments ?? [];
  const desc = card.description?.trim() ?? "";
  return (
    <ModalBackdrop onClose={onClose} labelledBy="archivedmodal-title">
      <div className="win cardmodal">
        <div className="cardmodal-head">
          <span className="pix cardmodal-crumb">ARCHIVED {timeAgo(card.archivedAt)} · READ-ONLY</span>
          <span className="cardmodal-ref">{cardRef(card)}</span>
          <button className="cardmodal-x" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="cardmodal-body">
          <h2 id="archivedmodal-title" className="archivedmodal-title">{card.title.trim() || "(untitled card)"}</h2>
          <div className="cardmodal-row">
            <span className="pix cardmodal-label">REPO</span>
            <span className="archivedmodal-value">{card.repo?.trim() || "—"}</span>
          </div>
          <div className="cardmodal-row">
            <span className="pix cardmodal-label">ASSIGNEE</span>
            <span className="archivedmodal-value">{card.assignee?.name ?? "Unassigned"}</span>
          </div>
          <div className="cardmodal-row">
            <span className="pix cardmodal-label">DESCRIPTION</span>
            <div className={`cardmodal-descview${desc ? "" : " is-empty"}`}>{desc ? renderMarkdown(desc) : "No description."}</div>
          </div>
          <div className="cardmodal-row">
            <span className="pix cardmodal-label">COMMENTS {comments.length ? `(${comments.length})` : ""}</span>
            <div className="cardmodal-comments">
              {comments.map((c) => (
                <div key={c.id} className="comment">
                  <div className="comment-meta">
                    <span className="comment-author">{c.author}</span>
                    <span className="comment-time">{timeAgo(c.at)}</span>
                  </div>
                  <div className="comment-text">{renderMarkdown(c.text)}</div>
                </div>
              ))}
              {!comments.length && <p className="cardmodal-empty">No comments.</p>}
            </div>
          </div>
          <div className="cardmodal-assign-actions">
            <button className="pix cardmodal-send" title="Put this card back on the board" onClick={onRestore}>RESTORE TO BOARD</button>
          </div>
        </div>
      </div>
    </ModalBackdrop>
  );
}
