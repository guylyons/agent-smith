import type { Card, Comment } from "../lib/board";

// Which board cards carry a comment you haven't read.
//
// A card's thread is where an agent reports what it found and what it decided,
// and the card face only ever said "💬 3" — a count that looks identical whether
// you read the thread a minute ago or an agent added two more since. So the
// board gave you no way to tell, at a glance, which cards want your eyes.
//
// The mark per card is the timestamp of the newest comment you have seen; a
// comment stamped later than the mark is unread. Timestamps rather than ids
// because a deleted comment must not resurrect the whole thread as unread.
//
// Pure — the caller owns the marks and passes its own byline in. Same split as
// unread.ts, whose desk badges do the equivalent job for agent state; the
// localStorage layer at the bottom is the only part that touches the browser.

/** cardId -> the `at` of the newest comment on it that has been read. */
export type ReadMarks = Record<string, number>;

/** Comments are read off the wire, so an entry can be anything. Take only the
 *  ones shaped like a comment; a malformed one is skipped, never thrown on. */
function commentsOf(card: Card): Comment[] {
  const raw = card.comments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Comment => !!c && typeof c === "object" && typeof (c as Comment).at === "number");
}

/** The newest comment stamp on a card, or 0 when it has nothing to read. */
export function newestCommentAt(card: Card): number {
  return commentsOf(card).reduce((max, c) => (c.at > max ? c.at : max), 0);
}

/**
 * How many comments on this card you haven't read: everything stamped after the
 * card's mark, minus your own — you don't need telling about what you just
 * wrote. A card with no mark has never been read, so all of it counts.
 */
export function unreadCommentCount(card: Card, marks: ReadMarks, me: string): number {
  const mark = marks[card.id] ?? 0;
  return commentsOf(card).filter((c) => c.at > mark && c.author !== me).length;
}

export function hasUnreadComments(card: Card, marks: ReadMarks, me: string): boolean {
  return unreadCommentCount(card, marks, me) > 0;
}

/** The marks after opening a card — everything on it now counts as read.
 *  A card with no comments still gets a mark, so the thread starts clean rather
 *  than counting the first arrival against a card you just looked at. */
export function markCardRead(marks: ReadMarks, card: Card): ReadMarks {
  return { ...marks, [card.id]: newestCommentAt(card) };
}

/**
 * Is this board worth taking a baseline from?
 *
 * Only once it actually has cards. The first board the UI renders is the empty
 * default, a moment ahead of the real one arriving over SSE — priming against
 * THAT stores an empty baseline, and every card on the real board then reads as
 * unread. So the baseline waits for a board with something on it.
 */
export function canPrime(cards: Card[]): boolean {
  return cards.length > 0;
}

/** The baseline for a browser that has never stored marks: everything already
 *  on the board counts as read. Without it a first load lights up every card
 *  that has ever been commented on, which teaches you to ignore the colour. */
export function primeMarks(cards: Card[]): ReadMarks {
  const marks: ReadMarks = {};
  for (const c of cards) marks[c.id] = newestCommentAt(c);
  return marks;
}

/** Drop marks for cards that no longer exist, so the store can't grow without
 *  bound as cards come and go. */
export function pruneMarks(marks: ReadMarks, cards: Card[]): ReadMarks {
  const live = new Set(cards.map((c) => c.id));
  const kept: ReadMarks = {};
  for (const [id, at] of Object.entries(marks)) if (live.has(id)) kept[id] = at;
  return kept;
}

// ---- browser storage --------------------------------------------------------

const LS_KEY = "aw-read-comments";

/** The stored marks, and whether a baseline has ever been taken. Unreadable or
 *  corrupt storage reads as "never primed", so the next real board takes a fresh
 *  baseline instead of flagging every card on it.
 *
 *  So does an EMPTY stored baseline: it's indistinguishable from a prime that
 *  raced the empty default board, and re-priming is the right answer either way
 *  — a browser that caught that race heals itself on the next load instead of
 *  staying lit up. */
export function loadMarks(): { marks: ReadMarks; primed: boolean } {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null) return { marks: {}, primed: false };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { marks: {}, primed: false };
    const marks: ReadMarks = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) marks[id] = at;
    }
    return { marks, primed: Object.keys(marks).length > 0 };
  } catch { return { marks: {}, primed: false }; }
}

export function saveMarks(marks: ReadMarks, cards: Card[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(pruneMarks(marks, cards))); }
  catch { /* storage unavailable — the highlight just won't survive a reload */ }
}
