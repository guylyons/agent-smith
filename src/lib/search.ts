// Quick-find search core — pure and browser-free so it's unit-tested without a
// DOM. Two halves: fuzzyScore() ranks a query against a string, and
// buildSearchItems() flattens a live snapshot (board cards + agent desks) into a
// flat list the palette fuzzy-matches over. Chat/transcript search is a separate
// server concern (it needs the filesystem); this file only handles what already
// rides in the snapshot.
import type { Snapshot } from "./snapshot";
import type { Board } from "./board";
import { cardRef } from "./ticket";

export type SearchKind = "card" | "agent";

/** One searchable thing. `id` is what the palette navigates to (a card id or a
 *  session id, per `kind`). `hay` is the precomputed, lowercased searchable text
 *  — title plus every other field worth matching on. `body` is the same prose in
 *  its original case and whitespace-flattened, kept so a body-only hit can be
 *  shown back to the user as a snippet rather than an unexplained row. */
export type SearchItem = {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  hay: string;
  body: string;
};

/** A ranked item, plus — when the query matched the body rather than the title —
 *  the excerpt of that body to show, with `marks` giving the indices of the
 *  matched characters within `snippet` so the palette can highlight them. */
export type SearchResult = SearchItem & { snippet?: string; marks?: number[] };

// Scoring weights. Kept small and legible: a subsequence match earns a base
// point per matched char, contiguous runs and word-boundary starts add bonuses,
// and a later start is gently penalised so earlier hits float up.
const CONTIGUOUS_BONUS = 8;
const WORD_START_BONUS = 12;
const TITLE_BONUS = 40;

function isWordBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  return prev === " " || prev === "-" || prev === "_" || prev === "/" || prev === ".";
}

/**
 * The index in `text` of each character of `query`, matched as an ordered
 * subsequence (leftmost-greedy), or null when they don't all appear in order.
 * Case-insensitive. An empty query is null — there's nothing to match.
 * Scoring and snippeting both read these positions, so a highlight can never
 * disagree with the match that earned the row its place.
 */
export function fuzzyPositions(query: string, text: string): number[] | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return null;

  const positions: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    positions.push(ti);
    qi++;
  }
  return qi < q.length ? null : positions;
}

/**
 * Score `query` against `text` as an ordered subsequence match (fuzzy), or null
 * when `query`'s characters don't all appear in order. Higher is a better match.
 * Case-insensitive. An empty query is null — there's nothing to rank on.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const positions = fuzzyPositions(query, text);
  if (!positions) return null;

  const t = text.toLowerCase();
  let score = 0;
  let prevMatch = -2; // so the first match is never "contiguous" with a phantom -1
  for (const ti of positions) {
    score += 1;
    if (ti === prevMatch + 1) score += CONTIGUOUS_BONUS;
    if (isWordBoundary(t, ti)) score += WORD_START_BONUS;
    prevMatch = ti;
  }

  // Prefer an earlier overall start: subtract a small amount for how deep the
  // first matched char sits, never enough to flip a genuinely stronger match.
  score -= Math.min(positions[0]!, 20) * 0.5;
  return score;
}

// Snippet window. The pad is what you get either side of the match; the cap
// stops a spread-out fuzzy match (whose first and last chars can sit paragraphs
// apart) from dragging the whole description into a one-line row.
const SNIPPET_PAD = 24;
const SNIPPET_MAX = 120;

/** Collapse every whitespace run to a single space, so a multi-line description
 *  can be excerpted into a one-line row. Done at build time, before any position
 *  is computed, so snippet indices always refer to this flattened form. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A one-line excerpt of `body` around where `query` fuzzy-matched, with `marks`
 * giving the indices of the matched characters *within the returned snippet* —
 * ellipses and edge trimming included — so a caller can highlight them without
 * re-running the match. Null when the query doesn't match `body` at all.
 */
export function matchSnippet(query: string, body: string): { snippet: string; marks: number[] } | null {
  const positions = fuzzyPositions(query, body);
  if (!positions) return null;

  const first = positions[0]!;
  const start = Math.max(0, first - SNIPPET_PAD);
  const end = Math.min(body.length, start + SNIPPET_MAX);

  // Trim the ragged half-word the slice can leave at each edge, then shift the
  // match positions by however much text now sits in front of them.
  const raw = body.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const core = raw.trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  const coreStart = start + lead;
  const offset = prefix.length - coreStart;

  return {
    snippet: `${prefix}${core}${suffix}`,
    marks: positions.filter((p) => p >= coreStart && p < coreStart + core.length).map((p) => p + offset),
  };
}

/** Concatenate the pieces of a card into one lowercased haystack. */
function cardHay(board: Board, ref: string, title: string, description: string, comments: string[], columnName: string): string {
  return [ref, title, description, columnName, ...comments].join(" ").toLowerCase();
}

/** Flatten a live snapshot into searchable items: every board card (matched on
 *  its id, title, description, comments and column) and every agent desk (matched on
 *  its name, role, ticket, current activity and location). */
export function buildSearchItems(snap: Snapshot): SearchItem[] {
  const out: SearchItem[] = [];

  const colName = new Map(snap.board.columns.map((c) => [c.id, c.name]));
  for (const card of snap.board.cards) {
    const columnName = colName.get(card.columnId) ?? "";
    const comments = (card.comments ?? []).map((m) => `${m.author}: ${m.text}`);
    out.push({
      kind: "card",
      id: card.id,
      title: card.title,
      subtitle: columnName || undefined,
      hay: cardHay(snap.board, cardRef(card), card.title, card.description ?? "", comments, columnName),
      // The column name is matchable but not worth excerpting — "backlog" as a
      // snippet tells you nothing the subtitle isn't already showing.
      body: flatten([card.description ?? "", ...comments].join(" ")),
    });
  }

  for (const a of snap.agents) {
    const bits = [a.name, a.role, a.ticket ?? "", a.doing, a.branch ?? "", a.cwd];
    out.push({
      kind: "agent",
      id: a.sessionId,
      title: a.name,
      subtitle: [a.role, a.ticket].filter(Boolean).join(" · ") || undefined,
      hay: bits.join(" ").toLowerCase(),
      body: flatten([a.doing, a.branch ?? "", a.cwd].join(" ")),
    });
  }

  return out;
}

/**
 * Rank `items` against `query`, best first, dropping non-matches. A match in the
 * title is boosted over a body-only match. An empty query returns the items
 * unranked (the palette's default listing), capped at `limit`.
 */
export function searchItems(items: SearchItem[], query: string, limit = 30): SearchResult[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit);

  const scored: { item: SearchItem; score: number; titleHit: boolean }[] = [];
  for (const item of items) {
    const t = fuzzyScore(q, item.title);
    const h = fuzzyScore(q, item.hay);
    const best = Math.max(t === null ? -Infinity : t + TITLE_BONUS, h ?? -Infinity);
    if (best !== -Infinity) scored.push({ item, score: best, titleHit: t !== null });
  }
  scored.sort((a, b) => b.score - a.score);

  // A title hit is self-explanatory — the matched text is already the row's
  // headline. Only a body-only hit needs to show its evidence.
  return scored.slice(0, limit).map(({ item, titleHit }) => {
    if (titleHit) return item;
    const hit = matchSnippet(q, item.body);
    return hit ? { ...item, snippet: hit.snippet, marks: hit.marks } : item;
  });
}
