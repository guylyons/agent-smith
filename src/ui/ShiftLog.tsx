import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Notif } from "../lib/notifications";
import { openCard } from "./nav";
import { notifFocus } from "./NotificationCenter";
import { clockTime, shiftLogSnapshot, shiftLogText, shiftLogView, subscribeShiftLog } from "./shiftEvents";

// The shift log: a thin CRT strip under the header with the last board events
// (moves, merges, comments, asks), newest first, each a button that opens its
// card. The events come from the notification center's diff (see shiftEvents.ts).
//
// Motion is news, not wallpaper: when an event arrives and the line is wider
// than the strip, it scrolls through twice and then stands still, newest at the
// left. THE LINE's fight strip below animates all the time, so a ticker that
// never stopped would be a second thing moving in the corner of your eye.
// Hover pauses it; focus stops the run so the item you tabbed to stays put.
// Under prefers-reduced-motion it never scrolls: the newest three, still.
// A merge flashes its item once (the tube blip is the Notifier's, behind the
// sound setting).

const PX_PER_SEC = 45;
const FLASH_MS = 2400;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function ShiftLog() {
  const feed = useSyncExternalStore(subscribeShiftLog, shiftLogSnapshot, shiftLogSnapshot);
  const reduced = useReducedMotion();
  const { items, scroll } = shiftLogView(feed, reduced);
  const newest = feed[0]?.id ?? "";

  // Ids that arrived while the page was open and should still flash.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string>>(new Set(feed.map((n) => n.id)));
  useEffect(() => {
    const arrived = feed.filter((n) => !seen.current.has(n.id)).map((n) => n.id);
    for (const id of arrived) seen.current.add(id);
    if (!arrived.length) return;
    setFresh((f) => new Set([...f, ...arrived]));
    const t = setTimeout(() => setFresh((f) => { const n = new Set(f); for (const id of arrived) n.delete(id); return n; }), FLASH_MS);
    return () => clearTimeout(t);
  }, [feed]);

  // Does one copy of the line overflow the strip? Only then is there anything
  // to scroll to. Measured on each new event and on resize.
  const windowRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLUListElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [durSec, setDurSec] = useState(20);
  useLayoutEffect(() => {
    const win = windowRef.current;
    if (!win) return;
    const measure = () => {
      const w = groupRef.current?.scrollWidth ?? 0;
      setOverflow(w > win.clientWidth + 1);
      setDurSec(Math.max(8, w / PX_PER_SEC));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(win);
    return () => ro.disconnect();
  }, [items.length, newest]);

  // One run per new event: two passes, then rest. Focus ends the run, and no
  // run starts while focus is inside: the item you tabbed to must not slide off.
  const sectionRef = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => { if (newest && !sectionRef.current?.contains(document.activeElement)) setRunning(true); }, [newest]);
  const moving = scroll && overflow && running;

  function onBlur(e: React.FocusEvent) {
    // Focus may have nudged the strip sideways to show an item; put it back.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null) && windowRef.current) windowRef.current.scrollLeft = 0;
  }

  const row = (n: Notif, copy: boolean) => (
    <li key={n.id} className={`shiftlog-item${n.merged ? " merged" : ""}${fresh.has(n.id) ? " fresh" : ""}`}>
      <button
        type="button"
        className="shiftlog-link"
        tabIndex={copy ? -1 : undefined}
        title={n.cardTitle ? `Open ${n.cardNum !== undefined ? `#${n.cardNum} ` : ""}${n.cardTitle}` : undefined}
        onClick={() => n.cardId && openCard(n.cardId, notifFocus(n))}
        disabled={!n.cardId}
      >
        <time className="shiftlog-time" dateTime={new Date(n.at).toISOString()}>{clockTime(n.at)}</time>{" "}
        {n.merged && <span aria-hidden="true">★ </span>}
        {shiftLogText(n)}
      </button>
    </li>
  );

  return (
    <section className={`shiftlog${reduced ? " still" : ""}`} aria-label="Shift log" ref={sectionRef} onFocus={() => setRunning(false)} onBlur={onBlur}>
      <span className="pix shiftlog-tag" aria-hidden="true">SHIFT LOG</span>
      <div className="shiftlog-window" ref={windowRef}>
        {items.length === 0 ? (
          <p className="shiftlog-empty">Listening. Moves, merges and comments show up here as they happen.</p>
        ) : (
          <div
            className={`shiftlog-track${moving ? " moving" : ""}`}
            style={{ "--shiftlog-dur": `${durSec}s` } as React.CSSProperties}
            onAnimationEnd={(e) => { if (e.target === e.currentTarget) setRunning(false); }}
          >
            <ul className="shiftlog-group" ref={groupRef}>{items.map((n) => row(n, false))}</ul>
            {/* The second copy makes the loop seamless; it is only ever seen,
                never read or tabbed to. */}
            {moving && <ul className="shiftlog-group" aria-hidden="true" inert>{items.map((n) => row(n, true))}</ul>}
          </div>
        )}
      </div>
    </section>
  );
}
