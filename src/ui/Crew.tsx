import { memo, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import type { AgentStatus } from "../schema";
import type { Board } from "../lib/board";
import { Sprite } from "./Sprite";
import { paletteFor } from "./sprite-data";
import { focusSession } from "./actions";
import { subscribeFlash } from "./flash";

// The specific thing a waiting session needs, instead of a generic WAITING —
// a permission prompt is a one-click, a question needs an answer, a plan needs
// a read. Unknown reason (scanner-only data) stays the generic call to action.
const WAIT_LABEL: Record<string, string> = {
  permission: "NEEDS PERMISSION",
  question: "ASKING YOU",
  plan: "PLAN REVIEW",
};

// Compact "how long it's been in this state": <1m, 12m, 3h, 2d. Empty when the
// hook/scanner hasn't stamped stateSince yet (old status file).
function inStateFor(stateSince: number | undefined, now: number): string {
  if (!stateSince) return "";
  const m = Math.floor((now - stateSince) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Dim a desk that's been idle this long — still present, visibly dormant.
const STALE_IDLE_MS = 30 * 60_000;

const stop = (e: MouseEvent) => e.stopPropagation();

// How long the "input sent" green ring lingers. Slightly past the CSS pulse
// (.7s) so the animation plays out fully before the class is pulled; also the
// hold duration for the reduced-motion static ring.
const FLASH_MS = 750;

// True while this card should show its send pulse. Bumps a counter on each send
// so rapid re-sends restart the timer; internal state, so it re-renders even
// though the card is memoized on props.
function useSendFlash(sessionId: string): boolean {
  const [pulse, setPulse] = useState(0);
  useEffect(() => subscribeFlash((id) => {
    if (id === sessionId) setPulse((n) => n + 1);
  }), [sessionId]);
  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(0), FLASH_MS);
    return () => clearTimeout(t);
  }, [pulse]);
  return pulse > 0;
}

// A fresh snapshot arrives every ~20s with new agent objects; only re-render a
// card when a field it actually shows changed. `onCard` is the board card this
// agent is assigned to ("title · column"), computed by Crew so the comparator
// stays a flat prop check.
const AgentCard = memo(function AgentCard({ a, onCard, unread, onOpen }: { a: AgentStatus; onCard: string; unread: boolean; onOpen: (id: string) => void }) {
  const { palette } = paletteFor(a.sessionId, a.role);
  const flashing = useSendFlash(a.sessionId);
  const now = Date.now();
  const dur = inStateFor(a.stateSince, now);
  const stale = a.state === "idle" && !!a.stateSince && now - a.stateSince > STALE_IDLE_MS;
  const stateLabel = a.state === "waiting"
    ? WAIT_LABEL[a.waitingReason ?? ""] ?? "NEED YOU"
    : a.state.toUpperCase();
  const repo = a.cwd.split("/").filter(Boolean).pop() ?? "";
  return (
    <article
      className={`win desk is-${a.state}${flashing ? " flash-send" : ""}${stale ? " is-stale" : ""}${unread ? " has-unread" : ""}`}
      role="button"
      tabIndex={0}
      title={unread ? `${a.name} has something for you to read` : "Click to open this agent's conversation"}
      onClick={() => onOpen(a.sessionId)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(a.sessionId);
        // Space activates on keyup per the ARIA button pattern, but scrolling
        // must be prevented here on keydown or the page jumps before then.
        else if (e.key === " " || e.key === "Spacebar") e.preventDefault();
      }}
      onKeyUp={(e) => { if (e.key === " " || e.key === "Spacebar") onOpen(a.sessionId); }}
    >
      {/* Something to READ: this agent finished, or stopped to ask. The alert
          centre says so once and scrolls away; this stays on the desk until the
          conversation is opened. */}
      {unread && (
        <div className="pix desk-unread" role="status" aria-label={`${a.name} has an unread message`}>
          <span aria-hidden="true">!</span>
        </div>
      )}
      <div className="desk-actions" onClick={stop}>
        <button className="deskbtn" title="Jump to this terminal in Ghostty"
          onClick={() => focusSession(a.sessionId)}>↗ TERMINAL</button>
      </div>
      <div className="sprite-wrap">
        <Sprite sessionId={a.sessionId} role={a.role} state={a.state} override={a.sprite} />
        {a.state === "waiting" && <div className="pix bubble">{a.waitingReason === "question" ? "?" : "!"}</div>}
        {!!a.subagents && a.subagents > 0 && (
          <div className="pix crew-badge" title={`${a.subagents} subagent${a.subagents > 1 ? "s" : ""} working`}>⊂{a.subagents}</div>
        )}
      </div>
      <div className="who">
        <div className="pix name">{a.name}</div>
        <div className="pix spec">{a.role}</div>
        {/* where it's working: repo basename · branch (persona desks lose the
            repo from their role line, so it lives here for everyone) */}
        <div className="pix repo" title={a.cwd}>
          {repo}{a.branch ? ` · ${a.branch}` : ""}
        </div>
        {/* only when a ticket exists — the repo line already says where this
            desk is working, so a bare em-dash chip earns nothing */}
        {a.ticket && <div className="pix ticket" style={{ color: palette.G }}>{a.ticket}</div>}
        {/* the board card this agent is assigned to, tying the desk to THE LINE */}
        {onCard && <div className="pix oncard" title={onCard}>▸ {onCard}</div>}
        <div className="doing">{a.doing}</div>
        <div className="pix state">
          <span className={`lamp ${a.state}`}></span>
          {stateLabel}
          {dur && <span className="statefor"> · {dur}</span>}
        </div>
      </div>
    </article>
  );
}, (prev, next) => {
  const x = prev.a, y = next.a;
  return prev.onOpen === next.onOpen && prev.onCard === next.onCard &&
    prev.unread === next.unread &&
    x.sessionId === y.sessionId && x.name === y.name && x.role === y.role &&
    x.ticket === y.ticket && x.state === y.state && x.doing === y.doing &&
    x.waitingReason === y.waitingReason && x.stateSince === y.stateSince &&
    x.cwd === y.cwd && x.branch === y.branch &&
    x.subagents === y.subagents &&
    x.sprite?.palette === y.sprite?.palette && x.sprite?.gear === y.sprite?.gear &&
    x.sprite?.body === y.sprite?.body;
});

/** "title · column" for the first board card assigned to this session (+N when
 *  it holds more), or "" — precomputed here so the memoized card compares a
 *  string, not the board. */
export function assignedCardLabel(board: Board, sessionId: string): string {
  const mine = board.cards.filter((c) => c.assignee?.id === sessionId);
  if (mine.length === 0) return "";
  const first = mine[0]!;
  const col = board.columns.find((c) => c.id === first.columnId);
  const more = mine.length > 1 ? ` +${mine.length - 1}` : "";
  return `${first.title} · ${col?.name ?? first.columnId}${more}`;
}

export function Crew({ agents, board, unread, onOpen }: {
  agents: AgentStatus[]; board: Board; unread: Set<string>; onOpen: (id: string) => void;
}) {
  // An empty grid used to render as nothing at all — a blank gap between the
  // header and THE LINE, with no hint that this is where sessions appear or how
  // to start one. Every other panel says what it would hold; so does this one.
  if (!agents.length) {
    return (
      <main className="crew crew-empty">
        <p className="pix">NO SESSIONS ON THE FLOOR</p>
        <p className="pix crew-empty-hint">
          Open a Claude Code session in any repo and its desk appears here, or hit
          <b> + NEW AGENT</b> to start one.
        </p>
      </main>
    );
  }

  return (
    <main className="crew">
      {agents.map((a) => (
        <AgentCard
          key={a.sessionId}
          a={a}
          onCard={assignedCardLabel(board, a.sessionId)}
          unread={unread.has(a.sessionId)}
          onOpen={onOpen}
        />
      ))}
    </main>
  );
}
