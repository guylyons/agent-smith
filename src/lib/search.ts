// Quick-find search core — pure and browser-free so it's unit-tested without a
// DOM. Two halves: fuzzyScore() ranks a query against a string, and
// buildSearchItems() flattens a live snapshot (board cards + agent desks) into a
// flat list the palette fuzzy-matches over. Chat/transcript search is a separate
// server concern (it needs the filesystem); this file only handles what already
// rides in the snapshot.
import type { Snapshot } from "./snapshot";
import type { Board } from "./board";

export type SearchKind = "card" | "agent";

/** One searchable thing. `id` is what the palette navigates to (a card id or a
 *  session id, per `kind`). `hay` is the precomputed, lowercased searchable text
 *  — title plus every other field worth matching on. */
export type SearchItem = {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  hay: string;
};

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
 * Score `query` against `text` as an ordered subsequence match (fuzzy), or null
 * when `query`'s characters don't all appear in order. Higher is a better match.
 * Case-insensitive. An empty query is null — there's nothing to rank on.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return null;

  let score = 0;
  let qi = 0;
  let firstMatch = -1;
  let prevMatch = -2; // so the first match is never "contiguous" with a phantom -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (firstMatch === -1) firstMatch = ti;
    score += 1;
    if (ti === prevMatch + 1) score += CONTIGUOUS_BONUS;
    if (isWordBoundary(t, ti)) score += WORD_START_BONUS;
    prevMatch = ti;
    qi++;
  }
  if (qi < q.length) return null; // not all query chars matched, in order

  // Prefer an earlier overall start: subtract a small amount for how deep the
  // first matched char sits, never enough to flip a genuinely stronger match.
  score -= Math.min(firstMatch, 20) * 0.5;
  return score;
}

/** Concatenate the pieces of a card into one lowercased haystack. */
function cardHay(board: Board, title: string, description: string, comments: string[], columnName: string): string {
  return [title, description, columnName, ...comments].join(" ").toLowerCase();
}

/** Flatten a live snapshot into searchable items: every board card (matched on
 *  its title, description, comments and column) and every agent desk (matched on
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
      hay: cardHay(snap.board, card.title, card.description ?? "", comments, columnName),
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
    });
  }

  return out;
}

/**
 * Rank `items` against `query`, best first, dropping non-matches. A match in the
 * title is boosted over a body-only match. An empty query returns the items
 * unranked (the palette's default listing), capped at `limit`.
 */
export function searchItems(items: SearchItem[], query: string, limit = 30): SearchItem[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit);

  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    const t = fuzzyScore(q, item.title);
    const h = fuzzyScore(q, item.hay);
    const best = Math.max(t === null ? -Infinity : t + TITLE_BONUS, h ?? -Infinity);
    if (best !== -Infinity) scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
