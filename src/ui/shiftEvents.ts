import type { Notif } from "../lib/notifications";

// The shift log's words and choices, kept out of the component so they can be
// tested: which board events it shows, how each one reads on the ticker, and
// whether the strip scrolls. The events themselves are the notification
// center's (diffNotifications), shared through publishShiftLog below, so the
// two never disagree about what happened.

/** How many events the ticker keeps. */
export const SHIFT_LOG_CAP = 12;
/** How many a reduced-motion viewer sees, as a still list. */
export const SHIFT_LOG_STILL = 3;

/** Board events only: an agent's desk going quiet ("needs you") is not a board
 *  event and already has the bell, the badge and the WAITING ON YOU chip. */
export function isShiftEvent(n: Notif): boolean {
  return n.kind !== "needs-you";
}

/** "14:02", in the viewer's local time. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function cardLabel(n: Notif): string {
  if (n.cardNum !== undefined) return `#${n.cardNum}`;
  return n.cardTitle ? `"${clip(n.cardTitle, 28)}"` : "a card";
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** One event as the ticker reads it (without the time):
 *  "DALLAS moved #117 to REVIEW", "#118 MERGED", "KANE on #117: tests green",
 *  "RIPLEY asks on #120: which port?". Names and columns in caps, like the rest
 *  of the header. The mover is the card's assignee: the snapshot does not say
 *  who dragged a card, and on this board it is nearly always the agent. */
export function shiftLogText(n: Notif): string {
  const who = (n.who || "someone").toUpperCase();
  const card = cardLabel(n);
  switch (n.kind) {
    case "move": {
      if (n.merged) return `${card} MERGED`;
      const to = n.text.replace(/^to /, "").toUpperCase();
      return n.who ? `${who} moved ${card} to ${to}` : `${card} moved to ${to}`;
    }
    case "comment":
      return `${who} on ${card}: ${clip(n.text, 60)}`;
    case "ask":
      return `${who} asks on ${card}: ${clip(n.text.replace(/^WAITING ON YOU:\s*/, ""), 60)}`;
    case "needs-you":
      return `${who} needs you`;
  }
}

/** What the strip shows: every kept event, scrolling, or — when the viewer
 *  asks for reduced motion — the newest few as a still list. */
export function shiftLogView(items: Notif[], reducedMotion: boolean): { items: Notif[]; scroll: boolean } {
  if (reducedMotion) return { items: items.slice(0, SHIFT_LOG_STILL), scroll: false };
  return { items, scroll: items.length > 0 };
}

// --- the shared feed ---------------------------------------------------------
// NotificationCenter already diffs every snapshot into events; it hands the
// board ones here, and the ticker listens. Clearing the inbox does not clear
// the log: they are two views of one stream, with their own lifetimes.

let feed: Notif[] = [];
const listeners = new Set<() => void>();

export function publishShiftLog(evs: Notif[]): void {
  const fresh = evs.filter(isShiftEvent);
  if (!fresh.length) return;
  feed = [...fresh.sort((a, b) => b.at - a.at), ...feed].slice(0, SHIFT_LOG_CAP);
  for (const l of listeners) l();
}

export function subscribeShiftLog(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function shiftLogSnapshot(): Notif[] {
  return feed;
}
