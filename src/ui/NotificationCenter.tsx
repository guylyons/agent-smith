import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../lib/snapshot";
import { diffNotifications, type Notif } from "../lib/notifications";
import { openCard, openAgent, type CardFocus } from "./nav";

const ME = "You";        // the human's byline, so their own comments never notify
const CAP = 50;          // most recent N events kept
const LS_KEY = "line.readNotifs";

function loadRead(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as string[]); }
  catch { return new Set(); }
}
function saveRead(ids: Set<string>, items: Notif[]): void {
  // Prune to events still on screen so the store can't grow without bound.
  const live = new Set(items.map((i) => i.id));
  try { localStorage.setItem(LS_KEY, JSON.stringify([...ids].filter((id) => live.has(id)))); }
  catch { /* storage unavailable — read-state just won't persist */ }
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Where on the card a notice should land: the comment it announced, or the
 *  stage row for a move. A needs-you opens the agent, not a card spot. */
export function notifFocus(n: Notif): CardFocus | undefined {
  if ((n.kind === "comment" || n.kind === "ask") && n.commentId) return { kind: "comment", id: n.commentId };
  if (n.kind === "move") return { kind: "stage" };
  return undefined;
}

const ICON: Record<Notif["kind"], string> = { comment: "💬", "needs-you": "⚠", move: "→", ask: "✋" };

/**
 * The header's notification inbox: a bell with an unread count, and a panel of
 * recent events (an agent's comment, an agent needing you, a card moving
 * forward) newest first. Clicking an item opens the card or agent behind it,
 * lands on the exact comment or stage change (highlighted while the card is
 * open), and marks it read. The diff that produces events is the pure diffNotifications;
 * this component owns the accumulated list and the read-state (persisted per
 * browser).
 */
export function NotificationCenter({ snap }: { snap: Snapshot }) {
  const [items, setItems] = useState<Notif[]>([]);
  const [read, setRead] = useState<Set<string>>(() => loadRead());
  const [open, setOpen] = useState(false);
  const prev = useRef<Snapshot | null>(null);

  useEffect(() => {
    // Baseline on the first POPULATED snapshot without emitting, so a page load
    // doesn't flood the inbox with the whole existing board (mirrors Notifier).
    if (prev.current === null) {
      if (snap.agents.length > 0 || snap.board.cards.length > 0) prev.current = snap;
      return;
    }
    const evs = diffNotifications(prev.current, snap, ME, Date.now());
    prev.current = snap;
    if (evs.length) setItems((cur) => [...evs, ...cur].slice(0, CAP));
  }, [snap]);

  const unread = items.filter((i) => !read.has(i.id)).length;

  function markAll(): void {
    setRead((r) => { const next = new Set(r); for (const i of items) next.add(i.id); saveRead(next, items); return next; });
  }
  function clearAll(): void {
    setItems([]);
    setRead((r) => { saveRead(r, []); return new Set(); });
  }
  function activate(n: Notif): void {
    setRead((r) => { const next = new Set(r).add(n.id); saveRead(next, items); return next; });
    if (n.kind === "needs-you" && n.sessionId) openAgent(n.sessionId);
    else if (n.cardId) openCard(n.cardId, notifFocus(n));
    setOpen(false);
  }

  const now = Date.now();

  return (
    <div className="notif">
      <button
        className={`notif-bell${unread ? " has-unread" : ""}`}
        title={unread ? `${unread} unread` : "Notifications"}
        aria-label={`Notifications: ${unread} unread`}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="notif-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <>
          <div className="notif-scrim" onClick={() => setOpen(false)} />
          <div className="notif-panel" role="dialog" aria-label="Notifications">
            <div className="notif-panel-head">
              <span className="pix">NOTIFICATIONS</span>
              <span className="notif-actions">
                {items.length > 0 && unread > 0 && <button className="notif-link" onClick={markAll}>mark all read</button>}
                {items.length > 0 && <button className="notif-link" onClick={clearAll}>clear</button>}
              </span>
            </div>
            <div className="notif-list">
              {items.length === 0 && <p className="notif-empty">Nothing yet.</p>}
              {items.map((n) => (
                <button
                  key={n.id}
                  className={`notif-item${read.has(n.id) ? "" : " unread"}`}
                  onClick={() => activate(n)}
                >
                  <span className="notif-kind" aria-hidden="true">{ICON[n.kind]}</span>
                  <span className="notif-body">
                    <span className="notif-line1">
                      <b>{n.who || "someone"}</b>
                      {n.cardTitle ? <span className="notif-card"> · {n.cardTitle}</span> : null}
                    </span>
                    <span className="notif-text">{n.text}</span>
                  </span>
                  <span className="notif-ago">{ago(n.at, now)}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
