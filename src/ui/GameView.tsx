import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus } from "../schema";
import type { Board } from "../lib/board";
import { Sprite } from "./Sprite";
import mapUrl from "./nostromo.png";
import {
  MAP_W, MAP_H, ROOMS, ROOM_IDS, placeAll, pathBetween, pathLength, pointAlong, spotFor, sleepers, cargoCount,
  type Pt, type RoomId, type Placement,
} from "./game";

// Walking speed, in map pixels per second: a cross-ship trip takes a few seconds.
const SPEED = 260;

type Walk = { room: RoomId; to: Pt; path: Pt[]; len: number; start: number };

/** An agent's identity on the map: its crew id when it has one, so a /clear
 *  (new session id, same crew member) doesn't look like a new arrival. */
const keyOf = (a: AgentStatus) => a.crew?.id ?? a.sessionId;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Where everyone is drawn this frame. Each agent keeps a walk: the path from
 *  where it was to where it now belongs. A change of room starts a new walk from
 *  wherever it currently stands; a newcomer walks in from the airlock. With
 *  reduced motion every walk is a jump. */
function useWalkers(agents: AgentStatus[], placed: Map<string, Placement>, ready: boolean): Map<string, Pt> {
  const walks = useRef(new Map<string, Walk>());
  const primed = useRef(false);
  const [now, setNow] = useState(() => performance.now());

  const t = performance.now();
  const reduce = prefersReducedMotion();
  const keep = new Set<string>();
  for (const a of agents) {
    const p = placed.get(a.sessionId);
    if (!p) continue;
    const k = keyOf(a);
    keep.add(k);
    const w = walks.current.get(k);
    if (w && w.room === p.room && w.to.x === p.at.x && w.to.y === p.at.y) continue;
    let path: Pt[];
    if (reduce) path = [p.at];
    else if (w) path = pathBetween(w.room, pointAlong(w.path, (t - w.start) * SPEED / 1000), p.room, p.at);
    else if (primed.current) path = pathBetween("airlock", spotFor("airlock", 0), p.room, p.at);
    else path = [p.at];
    walks.current.set(k, { room: p.room, to: p.at, path, len: pathLength(path), start: t });
  }
  for (const k of [...walks.current.keys()]) if (!keep.has(k)) walks.current.delete(k);
  // Anyone on the map before the first real snapshot was already aboard; only
  // later arrivals come in through the airlock.
  if (ready) primed.current = true;

  const out = new Map<string, Pt>();
  let moving = false;
  for (const [k, w] of walks.current) {
    const d = (now - w.start) * SPEED / 1000;
    if (d < w.len) moving = true;
    out.set(k, pointAlong(w.path, d));
  }

  // Tick frames only while someone is still walking.
  useEffect(() => {
    if (!moving) return;
    const id = requestAnimationFrame((ts) => setNow(ts));
    return () => cancelAnimationFrame(id);
  });
  return out;
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
  const at = useWalkers(agents, placed, ready);
  const asleep = useMemo(() => sleepers(board, agents), [board, agents]);
  const pods = ROOMS.hypersleep.spots.length;
  const cargo = cargoCount(board);

  return (
    <section className="win game" aria-label="Ship map">
      <div className="game-bar">
        <h2 className="pix">NOSTROMO</h2>
        <p className="pix hint">EACH AGENT STANDS WHERE ITS WORK IS · CLICK ONE TO OPEN ITS CONVERSATION</p>
      </div>
      <div className="game-scroll">
        <div className="game-map">
          <img className="game-art" src={mapUrl} alt="" width={MAP_W} height={MAP_H} draggable={false} />
          {ROOM_IDS.map((id) => (
            <div key={id} className="pix game-room" style={pct({ x: ROOMS[id].rect.x, y: ROOMS[id].rect.y })} aria-hidden="true">
              {ROOMS[id].label}
              {id === "cargo" && cargo > 0 && <span className="game-count"> · {cargo} DONE</span>}
            </div>
          ))}
          {asleep.slice(0, pods).map((s, i) => (
            <button key={s.who.crew ?? s.who.id} className="game-agent is-asleep" style={pct(spotFor("hypersleep", i))}
              aria-label={`${s.who.name}, in hypersleep: session ended, still on a card. Open the card.`}
              onClick={() => onOpenCard(s.cardId)}>
              <Sprite sessionId={s.who.id} role="" name={s.who.name} state="idle" />
              <span className="pix game-z" aria-hidden="true">z</span>
              <span className="pix game-tag" aria-hidden="true"><b>{s.who.name}</b><span>asleep · session ended</span></span>
            </button>
          ))}
          {asleep.length > pods && (
            <div className="pix game-room game-more" style={pct({ x: ROOMS.hypersleep.rect.x + ROOMS.hypersleep.rect.w - 50, y: ROOMS.hypersleep.rect.y + ROOMS.hypersleep.rect.h - 30 })}>
              +{asleep.length - pods} ASLEEP
            </div>
          )}
          {agents.map((a) => {
            const p = at.get(keyOf(a));
            const room = placed.get(a.sessionId)?.room;
            if (!p || !room) return null;
            const label = `${a.name}, ${ROOMS[room].label.toLowerCase()}, ${stateText(a)}${a.doing ? `: ${a.doing}` : ""}`;
            return (
              <button key={keyOf(a)} className={`game-agent is-${a.state}`} style={{ ...pct(p), zIndex: Math.round(p.y) }}
                aria-label={label} onClick={() => onOpen(a.sessionId)}>
                <Sprite sessionId={a.sessionId} role={a.role} name={a.name} state={a.state} override={a.sprite} />
                {a.state === "waiting" && <span className="pix bubble" aria-hidden="true">{a.waitingReason === "question" ? "?" : "!"}</span>}
                <span className="pix game-tag" aria-hidden="true"><b>{a.name}</b>{a.doing && <span>{a.doing}</span>}</span>
              </button>
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
