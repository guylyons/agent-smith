// Keyboard focus after Alt+Left/Right moves a card to another column.
//
// A card is keyed by id inside its column, so a move across columns unmounts
// the focused open button and mounts a fresh one in the new column: focus drops
// to the page and a keyboard user has to Tab from the top to find the card
// again. So a keyboard move leaves a note of which card it moved, and each board
// render while the note stands puts focus back on that card.
//
// The note has to outlive the first render. Press Alt+Right twice quickly and
// the server's echo of the FIRST move can arrive after the second has painted:
// for a moment the card is back a column, remounts, and drops focus again. So
// the note stands until the server's own board has the card where it was sent
// (or a few seconds pass, in case that never comes).
//
// Only the user's own keyboard move writes the note, so a card that an agent (or
// another tab) moves over SSE never pulls focus. And the note only acts when
// focus has actually been dropped: if the user is already somewhere else, or the
// move never happened and the button kept its focus, it is left alone.

import type { Board } from "../lib/board";

/** The card a keyboard move just sent to another column, awaiting refocus. */
export type PendingFocus = { cardId: string; toColumnId: string; at: number } | null;

/** How long a note may wait for the server to confirm the move. */
export const PENDING_FOCUS_MS = 5000;

/** Which card's open button to focus after a board render, or null for none.
 *  `focusDropped` is whether focus is on nothing (the body): true when the
 *  moved card's button was just unmounted. */
export function refocusAfterMove(
  pending: PendingFocus, board: Pick<Board, "cards">, focusDropped: boolean, now: number,
): string | null {
  if (!pending || !focusDropped || now - pending.at > PENDING_FOCUS_MS) return null;
  return board.cards.some((c) => c.id === pending.cardId) ? pending.cardId : null;
}

/** Whether the note can go: the server's board has the card in the column it
 *  was sent to (no stale echo can remount it after this), the card is gone, or
 *  the note has waited too long. */
export function moveSettled(pending: PendingFocus, server: Pick<Board, "cards">, now: number): boolean {
  if (!pending) return true;
  if (now - pending.at > PENDING_FOCUS_MS) return true;
  const card = server.cards.find((c) => c.id === pending.cardId);
  return !card || card.columnId === pending.toColumnId;
}
