import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentStatus } from "../schema";
import type { Board } from "../lib/board";
import { Sprite } from "./Sprite";
import mapUrl from "./nostromo.png";
import { hashFlag } from "./view";
import { inStateFor, isStaleIdle } from "./inState";
import {
  MAP_W, MAP_H, ROOMS, ROOM_IDS, placeAll, stepWalks, walkersAt, agentKey, spotFor, sleepers, cargoCount, roomsOverlay,
  tabOrder, scrollToShow, nudgeInto,
  type Pt, type Placement, type Walk,
} from "./game";

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Where everyone is drawn this frame. stepWalks does the bookkeeping on each
 *  new placement; this only ticks frames while someone is still walking. */
function useWalkers(agents: AgentStatus[], placed: Map<string, Placement>, ready: boolean): Map<string, Pt> {
  const walks = useRef(new Map<string, Walk>());
  // Anyone on the map before the first real snapshot was already aboard; only
  // later arrivals come in through the airlock.
  const primed = useRef(false);
  const [now, setNow] = useState(() => performance.now());

  const current = useMemo(() => {
    const next = stepWalks(walks.current, agents, placed, performance.now(), { reduceMotion: prefersReducedMotion(), primed: primed.current });
    walks.current = next;
    if (ready) primed.current = true;
    return next;
  }, [agents, placed, ready]);
  const { at, moving } = walkersAt(current, now);

  // Tick frames only while someone is still walking.
  useEffect(() => {
    if (!moving) return;
    const id = requestAnimationFrame((ts) => setNow(ts));
    return () => cancelAnimationFrame(id);
  });
  return at;
}

/** Is a debug flag on in the URL hash (#game?rooms=1)? Follows hash changes. */
function useHashFlag(name: string): boolean {
  const [on, setOn] = useState(() => hashFlag(location.hash, name));
  useEffect(() => {
    const onHash = () => setOn(hashFlag(location.hash, name));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [name]);
  return on;
}

/** Debug (#game?rooms=1): every room's rect, numbered spots, door, exit and
 *  waypoints, the last leg of each walk, and the corridor lines, drawn over
 *  the art so the points can be checked by eye. */
function RoomsOverlay() {
  const { rooms, lines } = roomsOverlay();
  return (
    <svg className="game-rooms" viewBox={`0 0 ${MAP_W} ${MAP_H}`} aria-hidden="true">
      {rooms.map((r) => (
        <rect key={r.id} className="rect" x={r.rect.x} y={r.rect.y} width={r.rect.w} height={r.rect.h} />
      ))}
      {lines.map((l, i) => <line key={i} className={l.kind} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} />)}
      {rooms.map((r) => (
        <g key={r.id}>
          <circle className="exit" cx={r.exit.x} cy={r.exit.y} r={7} />
          <circle className="door" cx={r.door.x} cy={r.door.y} r={7} />
          {r.vias.map((v, i) => <circle key={i} className="via" cx={v.x} cy={v.y} r={6} />)}
          {r.spots.map((p, i) => (
            <g key={i}>
              <circle className="spot" cx={p.x} cy={p.y} r={9} />
              <text x={p.x} y={p.y}>{i}</text>
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}

const pct = (p: Pt) => ({ left: `${(p.x / MAP_W) * 100}%`, top: `${(p.y / MAP_H) * 100}%` });

const WAIT_LABEL: Record<string, string> = { permission: "needs permission", question: "asking you", plan: "plan review" };

function stateText(a: AgentStatus): string {
  if (a.state === "waiting") return WAIT_LABEL[a.waitingReason ?? ""] ?? "needs you";
  return a.state;
}

/** Keep an agent's tag inside the scroll box: slide it sideways off an edge,
 *  and drop it below the sprite when there's no room above. Measured when the
 *  tag appears (hover or focus), since that's when it is laid out. */
function fitTag(e: { currentTarget: HTMLElement }) {
  const btn = e.currentTarget;
  const tag = btn.querySelector<HTMLElement>(".game-tag");
  const box = btn.closest(".game-scroll")?.getBoundingClientRect();
  if (!tag || !box) return;
  tag.style.removeProperty("--tag-dx");
  delete tag.dataset.below;
  const r = tag.getBoundingClientRect();
  if (!r.width) return;
  if (r.top < box.top + 4) tag.dataset.below = "";
  const dx = nudgeInto(r, box);
  if (dx) tag.style.setProperty("--tag-dx", `${dx}px`);
}

/** Once per open, if the map is bigger than its box: bring the first agent
 *  waiting on you into view, or centre the map. Skipped if the user has
 *  already scrolled. */
function useOpeningScroll(ref: RefObject<HTMLDivElement | null>, ready: boolean, target: Pt | undefined) {
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || done.current) return;
    const touched = () => { done.current = true; };
    el.addEventListener("pointerdown", touched, { once: true });
    el.addEventListener("wheel", touched, { once: true, passive: true });
    el.addEventListener("keydown", touched, { once: true });
    return () => {
      el.removeEventListener("pointerdown", touched);
      el.removeEventListener("wheel", touched);
      el.removeEventListener("keydown", touched);
    };
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    const map = el?.firstElementChild as HTMLElement | null;
    if (!el || !map || done.current || !ready) return;
    done.current = true;
    if (map.offsetWidth <= el.clientWidth && map.offsetHeight <= el.clientHeight) return;
    const { left, top } = scrollToShow(target, { w: map.offsetWidth, h: map.offsetHeight }, { w: el.clientWidth, h: el.clientHeight });
    el.scrollTo(left, top);
  }, [ref, ready, target]);
}

export function GameView({ agents, board, onOpen, onOpenCard }: {
  agents: AgentStatus[]; board: Board; onOpen: (id: string) => void; onOpenCard: (cardId: string) => void;
}) {
  // Spots are sticky: each placement starts from the last one.
  const lastPlaced = useRef<Map<string, Placement>>(new Map());
  const placed = useMemo(() => placeAll(agents, board, lastPlaced.current), [agents, board]);
  lastPlaced.current = placed;
  // The pre-connect placeholder board has no columns; the server always sends some.
  const ready = board.columns.length > 0;
  const at = useWalkers(agents, placed, ready);
  const asleep = useMemo(() => sleepers(board, agents), [board, agents]);
  const pods = ROOMS.hypersleep.spots.length;
  const cargo = cargoCount(board);
  const showRooms = useHashFlag("rooms");
  // Read per render, like the crew grid: snapshots re-render the map often
  // enough that minute-grained times stay current.
  const now = Date.now();
  const ordered = useMemo(() => tabOrder(agents), [agents]);
  const firstWaiting = ordered[0]?.state === "waiting" ? placed.get(agentKey(ordered[0]))?.at : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  useOpeningScroll(scroller, ready, firstWaiting);

  return (
    <section className="game" aria-label="Ship map: each agent stands where its work is. Click one to open its conversation.">
      <div className="game-scroll" ref={scroller}>
        <div className="game-map">
          <img className="game-art" src={mapUrl} alt="" width={MAP_W} height={MAP_H} draggable={false} />
          {showRooms && <RoomsOverlay />}
          {ROOM_IDS.map((id) => (
            <div key={id} className="pix game-room" style={pct({ x: ROOMS[id].rect.x, y: ROOMS[id].rect.y })} aria-hidden="true">
              {ROOMS[id].label}
              {id === "cargo" && cargo > 0 && <span className="game-count"> · {cargo} DONE</span>}
            </div>
          ))}
          {asleep.length > pods && (
            <div className="pix game-room game-more" style={pct({ x: ROOMS.hypersleep.rect.x + ROOMS.hypersleep.rect.w - 50, y: ROOMS.hypersleep.rect.y + ROOMS.hypersleep.rect.h - 30 })}>
              +{asleep.length - pods} ASLEEP
            </div>
          )}
          {ordered.map((a) => {
            const p = at.get(agentKey(a));
            const room = placed.get(agentKey(a))?.room;
            if (!p || !room) return null;
            const dur = inStateFor(a.stateSince, now);
            const state = `${stateText(a)}${dur ? ` · ${dur}` : ""}`;
            const label = `${a.name}, ${ROOMS[room].label.toLowerCase()}, ${stateText(a)}${dur ? ` for ${dur}` : ""}${a.doing ? `: ${a.doing}` : ""}`;
            return (
              <button key={agentKey(a)} className={`game-agent is-${a.state}${isStaleIdle(a, now) ? " is-stale" : ""}`}
                style={{ ...pct(p), zIndex: Math.round(p.y) }} aria-label={label} onClick={() => onOpen(a.sessionId)}
                onPointerEnter={fitTag} onFocus={fitTag}>
                <Sprite sessionId={a.sessionId} role={a.role} name={a.name} state={a.state} override={a.sprite} />
                {a.state === "waiting" && <span className="pix bubble" aria-hidden="true">{a.waitingReason === "question" ? "?" : "!"}</span>}
                <span className="pix game-name" aria-hidden="true">{a.name}</span>
                <span className="pix game-tag" aria-hidden="true"><b>{a.name} · {state}</b>{a.doing && <span>{a.doing}</span>}</span>
              </button>
            );
          })}
          {/* After the agents, so Tab reaches everyone awake first. */}
          {asleep.slice(0, pods).map((s, i) => (
            <button key={s.who.crew ?? s.who.id} className="game-agent is-asleep" style={pct(spotFor("hypersleep", i))}
              aria-label={`${s.who.name}, in hypersleep: session ended, still on a card. Open the card.`}
              onClick={() => onOpenCard(s.cardId)} onPointerEnter={fitTag} onFocus={fitTag}>
              <Sprite sessionId={s.who.id} role="" name={s.who.name} state="idle" />
              <span className="pix game-z" aria-hidden="true">z</span>
              <span className="pix game-name" aria-hidden="true">{s.who.name}</span>
              <span className="pix game-tag" aria-hidden="true"><b>{s.who.name}</b><span>asleep · session ended</span></span>
            </button>
          ))}
          {!agents.length && ready && (
            <p className="pix game-empty">NO SESSIONS ABOARD · START ONE WITH + NEW AGENT</p>
          )}
        </div>
      </div>
    </section>
  );
}
