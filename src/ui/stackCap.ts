// How tall a column's card stack is allowed to get on THE LINE.
//
// The cap is expressed in CARDS, not pixels, because a card face isn't a fixed
// height — a long title wraps, and a card with an assignee or comments grows a
// meta row. So the stack is measured: take the real heights of the first `rows`
// cards and cut there. Below the cap the column keeps growing naturally, so a
// short stack never gets a scrollbar it doesn't need.
//
// `peek` leaves a sliver of the next card showing below the cut. Without it the
// stack ends flush at a card edge and a full column is indistinguishable from a
// column of exactly `rows` cards — the scrollbar is an overlay one that hides at
// rest, so the clipped card is what says "there's more down here".
export function stackMaxHeight(
  heights: number[], rows: number, gap: number, pad = 0, peek = 0,
): number | null {
  if (!Number.isFinite(rows) || rows < 1) return null;      // 0 / OFF: no cap
  if (heights.length <= rows) return null;                  // nothing to hide
  const shown = heights.slice(0, rows);
  const content = shown.reduce((sum, h) => sum + h, 0) + gap * (shown.length - 1);
  // Never show more of the next card than there is of it.
  const sliver = Math.min(peek, gap + (heights[rows] ?? 0));
  return Math.round(content + sliver + pad);
}
