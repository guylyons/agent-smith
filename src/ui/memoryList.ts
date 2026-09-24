// The pure pieces of the MEMORY dialog (MemoryPanel.tsx): the query it sends
// to GET /memory, the order rows show in, and how dates, card links and the
// count read. DOM-free so they're tested directly.
// Types only: lib/memory reads the disk, and none of that belongs in the browser.
import type { FactKind, MemoryNode, NodeKind } from "../lib/memory";

/** lib/memory's FACT_KINDS, restated so the bundle doesn't pull that module in
 *  (a test holds the two equal). */
export const FACT_KINDS: readonly FactKind[] = ["decision", "gotcha", "note", "summary"];

/** Which nodes the list shows: every recorded fact (the default: cards would
 *  drown them), one kind, or everything, cards included. */
export type MemoryScope = "facts" | NodeKind | "all";
export const MEMORY_SCOPES: { id: MemoryScope; label: string }[] = [
  { id: "facts", label: "All facts" },
  ...FACT_KINDS.map((k) => ({ id: k, label: `${k[0]!.toUpperCase()}${k.slice(1)}s` })),
  { id: "card", label: "Cards" },
  { id: "all", label: "Facts and cards" },
];

/** The most rows asked for: GET /memory's own cap. */
export const MEMORY_LIMIT = 200;

/** GET /memory's q: the scope as a kind: filter, then the typed words (which
 *  may carry their own filters, e.g. person:VASQUEZ). */
export function memoryQuery(text: string, scope: MemoryScope): string {
  const kind = scope === "all" ? "" : `kind:${scope === "facts" ? FACT_KINDS.join(",") : scope}`;
  return [kind, ...text.trim().split(/\s+/).filter(Boolean)].filter(Boolean).join(" ");
}

const touched = (n: MemoryNode) => n.updatedAt ?? n.at;

/** Newest first, by last update. The server ranks by match score when there
 *  are words; the list reads as a log, so it re-sorts. */
export function newestFirst(nodes: MemoryNode[]): MemoryNode[] {
  return [...nodes].sort((a, b) => touched(b) - touched(a));
}

/** The node's last-touched day, YYYY-MM-DD (UTC, as the MCP digest shows it). */
export function memoryDay(n: MemoryNode): string {
  const t = touched(n);
  return t ? new Date(t).toISOString().slice(0, 10) : "no date";
}

/** The cards a node points at, once each: its card: links, or itself when it
 *  is a card. */
export function cardIdsOf(n: MemoryNode): string[] {
  const ids = n.kind === "card" && n.id.startsWith("card:") ? [n.id.slice(5)] : [];
  for (const l of n.links ?? []) if (l.startsWith("card:")) ids.push(l.slice(5));
  return [...new Set(ids)];
}

/** How a card link reads: "#42 Title" when it is on the board (so it opens),
 *  else its id, marked as not openable. */
export function linkLabel(cardId: string, cards: { id: string; num?: number; title: string }[]): { text: string; onBoard: boolean } {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return { text: `${cardId} (not on the board)`, onBoard: false };
  const title = card.title.trim() || "(untitled card)";
  return { text: card.num ? `#${card.num} ${title}` : title, onBoard: true };
}

/** The line over the list. At the limit, more may match than came back. */
export function countNote(n: number): string {
  if (!n) return "Nothing in memory matches.";
  if (n >= MEMORY_LIMIT) return `The best ${MEMORY_LIMIT} matches, newest first. Narrow the filter to see others.`;
  return `${n} ${n === 1 ? "entry" : "entries"}, newest first`;
}
