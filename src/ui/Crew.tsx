import { memo, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { paletteFor } from "./sprite-data";
import { focusSession } from "./actions";
import { subscribeFlash } from "./flash";

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
// card when a field it actually shows changed.
const AgentCard = memo(function AgentCard({ a, onOpen }: { a: AgentStatus; onOpen: (id: string) => void }) {
  const { palette } = paletteFor(a.sessionId, a.role);
  const flashing = useSendFlash(a.sessionId);
  return (
    <article
      className={`win desk is-${a.state}${flashing ? " flash-send" : ""}`}
      role="button"
      tabIndex={0}
      title="Click to open this agent's conversation"
      onClick={() => onOpen(a.sessionId)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(a.sessionId);
        // Space activates on keyup per the ARIA button pattern, but scrolling
        // must be prevented here on keydown or the page jumps before then.
        else if (e.key === " " || e.key === "Spacebar") e.preventDefault();
      }}
      onKeyUp={(e) => { if (e.key === " " || e.key === "Spacebar") onOpen(a.sessionId); }}
    >
      <div className="desk-actions" onClick={stop}>
        <button className="deskbtn" title="Jump to this terminal in Ghostty"
          onClick={() => focusSession(a.sessionId)}>↗ TERMINAL</button>
      </div>
      <div className="sprite-wrap">
        <Sprite sessionId={a.sessionId} role={a.role} state={a.state} override={a.sprite} />
        {a.state === "waiting" && <div className="pix bubble">!</div>}
        {!!a.subagents && a.subagents > 0 && (
          <div className="pix crew-badge" title={`${a.subagents} subagent${a.subagents > 1 ? "s" : ""} working`}>⊂{a.subagents}</div>
        )}
      </div>
      <div className="who">
        <div className="pix name">{a.name}</div>
        <div className="pix spec">{a.role}</div>
        <div className="pix ticket" style={{ color: palette.G }}>{a.ticket ?? "—"}</div>
        <div className="doing">{a.doing}</div>
        <div className="pix state">
          <span className={`lamp ${a.state}`}></span>
          {a.state.toUpperCase()}
        </div>
      </div>
    </article>
  );
}, (prev, next) => {
  const x = prev.a, y = next.a;
  return prev.onOpen === next.onOpen &&
    x.sessionId === y.sessionId && x.name === y.name && x.role === y.role &&
    x.ticket === y.ticket && x.state === y.state && x.doing === y.doing &&
    x.subagents === y.subagents &&
    x.sprite?.palette === y.sprite?.palette && x.sprite?.gear === y.sprite?.gear &&
    x.sprite?.body === y.sprite?.body;
});

export function Crew({ agents, onOpen }: { agents: AgentStatus[]; onOpen: (id: string) => void }) {
  return (
    <main className="crew">
      {agents.map((a) => <AgentCard key={a.sessionId} a={a} onOpen={onOpen} />)}
    </main>
  );
}
