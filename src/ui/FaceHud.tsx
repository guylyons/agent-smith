import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus } from "../schema";
import type { Board } from "../lib/board";
import {
  pickFace, faceTitle,
  FACE_COLS, FACE_ROWS, FACE_CELL_W, FACE_CELL_H,
  type Face, type FaceState,
} from "../lib/face";
import { fleetUsage } from "./UsageMeter";
import { boardMoves, isCompletion, type PrevCols } from "./soundEvents";
import facesUrl from "./faces.png";

// Displayed at exactly 2x the native cell, so every source pixel maps to a whole
// 2x2 block and the sprite stays crisp under image-rendering: pixelated.
const SCALE = 2;

// How often the idle rotation re-rolls. Slow enough to read as glances rather
// than a strobe; DOOM's own face turns on roughly this cadence.
const FLICKER_MS = 2200;

// How long the shout holds after a card lands in DONE.
const CELEBRATE_MS = 1600;

/** Track `prefers-reduced-motion`, live. Under it the face is picked once from
 *  the fleet's state and then held — still informative, never flickering. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { return; }
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** True for a beat after any card lands in DONE. Diffs the board itself rather
 *  than listening for the toast, so the HUD owns its own timing and can't be
 *  thrown off by whether notifications happen to be enabled. */
function useCelebration(board: Board): boolean {
  const [celebrating, setCelebrating] = useState(false);
  const prevRef = useRef<PrevCols>(new Map());
  const primedRef = useRef(false);

  useEffect(() => {
    const { moves, next } = boardMoves(prevRef.current, board, primedRef.current);
    prevRef.current = next;
    // The first populated board is a baseline: cards already sitting in DONE on
    // load are not fresh wins.
    if (!primedRef.current) { primedRef.current = board.cards.length > 0; return; }
    if (!moves.some(isCompletion)) return;

    setCelebrating(true);
    const id = setTimeout(() => setCelebrating(false), CELEBRATE_MS);
    return () => clearTimeout(id);
  }, [board]);

  return celebrating;
}

/**
 * The status-bar face: Agent Smith reacting to the fleet, pinned bottom-centre
 * the way DOOM's is. The row he's wearing tracks the same token budget the usage
 * meter reports, so the two never disagree.
 */
export function FaceHud({ agents, board }: { agents: AgentStatus[]; board: Board }) {
  const reduced = useReducedMotion();
  const celebrating = useCelebration(board);

  const usage = fleetUsage(agents);
  const pct = usage ? usage.pct : null;
  const waiting = agents.filter((a) => a.state === "waiting").length;
  const working = agents.filter((a) => a.state === "working").length;

  // Memoised on primitives so the effects below re-run when the fleet actually
  // changes, not on every snapshot poll that returns identical numbers.
  const state: FaceState = useMemo(
    () => ({ pct, waiting, working, agents: agents.length, celebrating }),
    [pct, waiting, working, agents.length, celebrating],
  );

  const stateRef = useRef(state);
  stateRef.current = state;

  const [face, setFace] = useState<Face>(() => pickFace(state));

  // React at once when the fleet changes — waiting on you should show now, not
  // at the next flicker.
  useEffect(() => { setFace(pickFace(state)); }, [state]);

  // The idle rotation. Skipped entirely under reduced motion, and held while the
  // tab is hidden so a backgrounded dashboard isn't re-rendering for nobody.
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      setFace(pickFace(stateRef.current));
    }, FLICKER_MS);
    return () => clearInterval(id);
  }, [reduced]);

  const label = faceTitle(state);

  return (
    <div className="facehud" title={label}>
      <div
        className="facehud-face"
        role="img"
        aria-label={label}
        style={{
          backgroundImage: `url(${facesUrl})`,
          width: FACE_CELL_W * SCALE,
          height: FACE_CELL_H * SCALE,
          backgroundSize: `${FACE_COLS * FACE_CELL_W * SCALE}px ${FACE_ROWS * FACE_CELL_H * SCALE}px`,
          backgroundPosition: `-${face.col * FACE_CELL_W * SCALE}px -${face.row * FACE_CELL_H * SCALE}px`,
        }}
      />
    </div>
  );
}
