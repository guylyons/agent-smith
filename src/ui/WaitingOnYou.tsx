import { useEffect, useRef, useState } from "react";
import { waitingOnYou, type Board, type Card } from "../lib/board";
import { openCard } from "./nav";

/** The HUD's words for N open questions; empty at zero, when it hides. */
export function waitingLabel(n: number): string {
  return n > 0 ? `${n} waiting on you` : "";
}

/** The asks in `curr` that `prev` didn't have, by comment id. Pure, so the
 *  live region's "what's new" is tested without rendering. */
export function newAsks(prev: Set<string>, cards: Pick<Card, "ask" | "title">[]): Pick<Card, "ask" | "title">[] {
  return cards.filter((k) => k.ask && !prev.has(k.ask.commentId));
}

/**
 * The header's "N WAITING ON YOU": cards where an agent asked the human a
 * question with "ask":true and nobody has answered on the card yet. Pressing it
 * opens the oldest one, on the question itself. Hidden at zero.
 *
 * It also owns the polite live region that says when a NEW question comes in.
 * The region stays mounted at zero, or the first ask would have nowhere to be
 * announced from. The first populated board is a baseline, so a page load
 * doesn't read out every open question.
 */
export function WaitingOnYou({ board }: { board: Board }) {
  const waiting = waitingOnYou(board.cards);
  const [said, setSaid] = useState("");
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const ids = new Set(waiting.map((k) => k.ask.commentId));
    if (seen.current === null) {
      if (board.cards.length > 0) seen.current = ids;
      return;
    }
    const fresh = newAsks(seen.current, waiting);
    seen.current = ids;
    if (fresh.length === 1) setSaid(`${fresh[0]!.ask!.by} is waiting on you: ${fresh[0]!.title || "Untitled"}`);
    else if (fresh.length > 1) setSaid(`${fresh.length} new questions waiting on you`);
  }, [board]);

  const oldest = waiting[0];
  return (
    <>
      {oldest && (
        <button
          type="button"
          className="pix waiting-hud"
          title={`Open the oldest: "${oldest.title || "Untitled"}", asked by ${oldest.ask.by}`}
          aria-label={`${waitingLabel(waiting.length)}. Open the oldest: ${oldest.title || "Untitled"}`}
          onClick={() => openCard(oldest.id, { kind: "comment", id: oldest.ask.commentId })}
        >
          <span aria-hidden="true">✋ </span>{waitingLabel(waiting.length).toUpperCase()}
        </button>
      )}
      <span className="sr-only" role="status" aria-live="polite">{said}</span>
    </>
  );
}

/** The card modal's banner for an open question: what was asked, by whom, and
 *  a CLEAR for a question answered somewhere other than the card. Replying on
 *  the card clears it too. */
export function AskBanner({ card, onClear }: { card: Card; onClear: () => void }) {
  const m = card.ask && card.comments?.find((c) => c.id === card.ask!.commentId);
  if (!card.ask || !m) return null;
  return (
    <section className="cardmodal-ask" aria-labelledby="cardmodal-ask-label">
      <div className="comment-meta">
        <span id="cardmodal-ask-label" className="pix ask-tag"><span aria-hidden="true">✋ </span>WAITING ON YOU</span>
        <span className="comment-author">{card.ask.by}</span>
        <button type="button" className="pix comment-pin" onClick={onClear}
          title="Take the flag off without replying (replying here clears it too)">CLEAR</button>
      </div>
      <div className="comment-text ask-text">{m.text}</div>
    </section>
  );
}
