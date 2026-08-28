import type { Board } from "./board";
import type { AgentStatus } from "../schema";

/** What a notification is about. */
export type NotifKind = "comment" | "needs-you" | "move";

/** One thing worth telling the human about, derived from a change between two
 *  snapshots. `id` is stable for the underlying event so read-state survives
 *  re-renders and repeated diffs. */
export type Notif = {
  id: string;
  kind: NotifKind;
  at: number;
  who: string;            // the agent behind it (comment author, waiting agent, assignee)
  text: string;           // a short human-readable description / snippet
  cardId?: string;        // the card to open, when there is one
  cardTitle?: string;
  sessionId?: string;     // the agent to open, for a needs-you
};

type Snap = { agents: AgentStatus[]; board: Board };

/**
 * Diff two consecutive snapshots into notifications for the human. Emits for
 * three things:
 *
 *  - a new comment an agent posted on any card (never the human's own),
 *  - an agent entering the waiting state (it needs an answer),
 *  - a card moving forward a column (work advanced, e.g. into Review/Done).
 *
 * Backward moves are ignored (dragging a card back is not news), and the first
 * snapshot (prev === null) emits nothing so a page load doesn't flood the inbox
 * with the entire existing board. Pure: the caller owns prev/curr and the
 * read-state store.
 */
export function diffNotifications(prev: Snap | null, curr: Snap, me: string, now: number): Notif[] {
  if (!prev) return [];
  const out: Notif[] = [];

  // --- new agent comments ---------------------------------------------------
  const seen = new Set<string>();
  for (const c of prev.board.cards) for (const m of c.comments ?? []) seen.add(m.id);
  for (const card of curr.board.cards) {
    for (const m of card.comments ?? []) {
      if (seen.has(m.id) || m.author === me) continue;
      out.push({
        id: `comment:${m.id}`,
        kind: "comment",
        at: m.at,
        who: m.author,
        text: m.text,
        cardId: card.id,
        cardTitle: card.title,
      });
    }
  }

  // --- agents newly waiting on the human ------------------------------------
  const prevState = new Map(prev.agents.map((a) => [a.sessionId, a.state]));
  for (const a of curr.agents) {
    if (a.state !== "waiting" || prevState.get(a.sessionId) === "waiting") continue;
    const card = curr.board.cards.find((k) => k.assignee?.id === a.sessionId);
    out.push({
      id: `need:${a.sessionId}:${a.stateSince ?? now}`,
      kind: "needs-you",
      at: now,
      who: a.name,
      text: `waiting on you (${a.waitingReason ?? "needs input"})`,
      sessionId: a.sessionId,
      cardId: card?.id,
      cardTitle: card?.title,
    });
  }

  // --- cards moved forward --------------------------------------------------
  const colIndex = new Map(curr.board.columns.map((c, i) => [c.id, i]));
  const colName = new Map(curr.board.columns.map((c) => [c.id, c.name || c.id]));
  const prevCol = new Map(prev.board.cards.map((c) => [c.id, c.columnId]));
  for (const card of curr.board.cards) {
    const from = prevCol.get(card.id);
    if (from === undefined || from === card.columnId) continue;
    const fi = colIndex.get(from);
    const ti = colIndex.get(card.columnId);
    // Forward only: a card dragged back a column is not news.
    if (fi === undefined || ti === undefined || ti <= fi) continue;
    out.push({
      id: `move:${card.id}:${card.columnId}:${now}`,
      kind: "move",
      at: now,
      who: card.assignee?.name ?? "",
      text: `to ${colName.get(card.columnId)}`,
      cardId: card.id,
      cardTitle: card.title,
    });
  }

  return out;
}
