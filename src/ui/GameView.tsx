import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus } from "../schema";
import type { Board } from "../lib/board";
import { Sprite } from "./Sprite";
import mapUrl from "./nostromo.png";
import { hashFlag } from "./view";
import { inStateFor, isStaleIdle } from "./inState";
import {
  MAP_W, MAP_H, ROOMS, ROOM_IDS, placeAll, stepWalks, walkersAt, agentKey, sleepers, sleeperKey, cargoCount, roomsOverlay,
  type Pt, type Placement, type Walk, type Sleeper,
} from "./game";

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Where everyone is drawn this frame. stepWalks does the bookkeeping on each
 *  new placement; this only ticks frames while someone is still walking. */
function useWalkers(agents: AgentStatus[], placed: Map<string, Placement>, asleep: Sleeper[], ready: boolean): { walks: Map<string, Walk>; at: Map<string, Pt> } {
  const walks = useRef(new Map<string, Walk>());
  // Anyone on the map before the first real snapshot was already aboard; only
  // later arrivals come in through the airlock.
  const primed = useRef(false);
  const [now, setNow] = useState(() => performance.now());

  const current = useMemo(() => {
    const next = stepWalks(walks.current, agents, placed, performance.now(), { reduceMotion: prefersReducedMotion(), primed: primed.current, asleep });
    walks.current = next;
    if (ready) primed.current = true;
    return next;
  }, [agents, placed, asleep, ready]);
  const { at, moving } = walkersAt(current, now);

  // Tick frames only while someone is still walking.
  useEffect(() => {
    if (!moving) return;
    const id = requestAnimationFrame((ts) => setNow(ts));
    return () => cancelAnimationFrame(id);
  });
  return { walks: current, at };
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

export function GameView({ agents, board, onOpen, onOpenCard }: {
  agents: AgentStatus[]; board: Board; onOpen: (id: string) => void; onOpenCard: (cardId: string) => void;
}) {
  // Spots are sticky: each placement starts from the last one.
  const lastPlaced = useRef<Map<string, Placement>>(new Map());
  const placed = useMemo(() => placeAll(agents, board, lastPlaced.current), [agents, board]);
  lastPlaced.current = placed;
  // The pre-connect placeholder board has no columns; the server always sends some.
  const ready = board.columns.length > 0;
  const asleep = useMemo(() => sleepers(board, agents), [board, agents]);
  const { walks, at } = useWalkers(agents, placed, asleep, ready);
  // How everyone on the map last looked, so someone walking out, or to a pod,
  // keeps the sprite they had.
  const looks = useRef(new Map<string, Pick<AgentStatus, "sessionId" | "role" | "name" | "sprite">>());
  for (const s of asleep) if (!looks.current.has(sleeperKey(s))) looks.current.set(sleeperKey(s), { sessionId: s.who.id, role: "", name: s.who.name });
  for (const a of agents) looks.current.set(agentKey(a), a);
  for (const k of looks.current.keys()) if (!walks.has(k)) looks.current.delete(k);
  const arrived = (k: string) => { const w = walks.get(k), p = at.get(k); return !!w && !!p && p.x === w.to.x && p.y === w.to.y; };
  const pods = ROOMS.hypersleep.spots.length;
  const cargo = cargoCount(board);
  const showRooms = useHashFlag("rooms");
  // Read per render, like the crew grid: snapshots re-render the map often
  // enough that minute-grained times stay current.
  const now = Date.now();

  return (
    <section className="game" aria-label="Ship map: each agent stands where its work is. Click one to open its conversation.">
      <div className="game-scroll">
        <div className="game-map">
          <img className="game-art" src={mapUrl} alt="" width={MAP_W} height={MAP_H} draggable={false} />
          {showRooms && <RoomsOverlay />}
          {ROOM_IDS.map((id) => (
            <div key={id} className="pix game-room" style={pct({ x: ROOMS[id].rect.x, y: ROOMS[id].rect.y })} aria-hidden="true">
              {ROOMS[id].label}
              {id === "cargo" && cargo > 0 && <span className="game-count"> · {cargo} DONE</span>}
            </div>
          ))}
          {asleep.map((s) => {
            // In its pod. On the walk there it is drawn below, with the leavers.
            const k = sleeperKey(s), look = looks.current.get(k);
            if (!look || walks.get(k)?.room !== "hypersleep" || !arrived(k)) return null;
            return (
              <button key={k} className="game-agent is-asleep" style={pct(at.get(k)!)}
                aria-label={`${s.who.name}, in hypersleep: session ended, still on a card. Open the card.`}
                onClick={() => onOpenCard(s.cardId)}>
                <Sprite sessionId={look.sessionId} role={look.role} name={look.name} state="idle" override={look.sprite} />
                <span className="pix game-z" aria-hidden="true">z</span>
                <span className="pix game-tag" aria-hidden="true"><b>{s.who.name}</b><span>asleep · session ended</span></span>
              </button>
            );
          })}
          {asleep.length > pods && (
            <div className="pix game-room game-more" style={pct({ x: ROOMS.hypersleep.rect.x + ROOMS.hypersleep.rect.w - 50, y: ROOMS.hypersleep.rect.y + ROOMS.hypersleep.rect.h - 30 })}>
              +{asleep.length - pods} ASLEEP
            </div>
          )}
          {agents.map((a) => {
            const p = at.get(agentKey(a));
            const room = placed.get(agentKey(a))?.room;
            if (!p || !room) return null;
            const dur = inStateFor(a.stateSince, now);
            const state = `${stateText(a)}${dur ? ` · ${dur}` : ""}`;
            const label = `${a.name}, ${ROOMS[room].label.toLowerCase()}, ${stateText(a)}${dur ? ` for ${dur}` : ""}${a.doing ? `: ${a.doing}` : ""}`;
            return (
              <button key={agentKey(a)} className={`game-agent is-${a.state}${isStaleIdle(a, now) ? " is-stale" : ""}`}
                style={{ ...pct(p), zIndex: Math.round(p.y) }} aria-label={label} onClick={() => onOpen(a.sessionId)}>
                <Sprite sessionId={a.sessionId} role={a.role} name={a.name} state={a.state} override={a.sprite} />
                {a.state === "waiting" && <span className="pix bubble" aria-hidden="true">{a.waitingReason === "question" ? "?" : "!"}</span>}
                <span className="pix game-tag" aria-hidden="true"><b>{a.name} · {state}</b>{a.doing && <span>{a.doing}</span>}</span>
              </button>
            );
          })}
          {[...walks.keys()].map((k) => {
            // Session ended, still walking to the airlock or a pod: drawn, but
            // nothing to click or tab to.
            const p = at.get(k), look = looks.current.get(k);
            if (!p || !look || placed.has(k) || arrived(k)) return null;
            return (
              <div key={k} className="game-agent is-leaving" style={{ ...pct(p), zIndex: Math.round(p.y) }} aria-hidden="true">
                <Sprite sessionId={look.sessionId} role={look.role} name={look.name} state="idle" override={look.sprite} />
              </div>
            );
          })}
          {!agents.length && ready && (
            <p className="pix game-empty">NO SESSIONS ABOARD · START ONE WITH + NEW AGENT</p>
          )}
        </div>
      </div>
    </section>
  );
}
