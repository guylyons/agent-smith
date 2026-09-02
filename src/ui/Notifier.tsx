import { useEffect, useRef } from "react";
import type { Snapshot } from "../lib/snapshot";
import { soundTransitions, boardMoves, isCompletion, type PrevState, type PrevCols } from "./soundEvents";
import { playCue } from "./sounds";
import { toast } from "./toast";

function notify(name: string, waitingReason: "permission" | "question" | "plan" | undefined, doing: string) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const body = waitingReason ?? doing;
    new Notification(`${name} needs you`, { body });
  } catch {
    /* ignore */
  }
}

// Fires sound cues (completion / question / permission on agent state changes,
// and a move blip when a card changes column) plus a desktop notification when
// agents change state, and a party toast when a card reaches Done. Renders
// nothing — the on/off control lives in the Settings panel (App owns it). The
// which-cue decisions are the pure soundTransitions()/boardMoves() (see
// soundEvents.ts); this effect just plays, notifies, and celebrates.
export function Notifier({ snap, enabled }: { snap: Snapshot; enabled: boolean }) {
  const prevState = useRef<PrevState>(new Map());
  const prevCols = useRef<PrevCols>(new Map());
  const primed = useRef(false);
  const boardPrimed = useRef(false);

  useEffect(() => {
    const prev = prevState.current;
    const { cues, next } = soundTransitions(prev, snap.agents, primed.current);
    const { moves, next: nextCols } = boardMoves(prevCols.current, snap.board, boardPrimed.current);

    if (enabled) {
      for (const cue of cues) playCue(cue);

      // Desktop notifications, only for "needs you" (waiting) transitions —
      // completion is sound-only. Derived from the same prev->current diff.
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        for (const agent of snap.agents) {
          if (primed.current && agent.state === "waiting" && prev.get(agent.sessionId) !== "waiting") {
            notify(agent.name, agent.waitingReason, agent.doing);
          }
        }
      }
    }

    // Board-move feedback. The move blip is audio (gated by the sound toggle);
    // the completion party toast is visual and always shows, so a finished
    // hand-off is unmistakable even with sound off.
    for (const move of moves) {
      if (isCompletion(move, snap.board)) {
        toast(`🎉 ${move.title} — done!`);
        if (enabled) playCue("celebrate");
      } else if (enabled) {
        playCue("move");
      }
    }

    prevState.current = next;
    prevCols.current = nextCols;
    // Establish the baseline on the first POPULATED snapshot without firing, so
    // we don't alert for every agent that's already waiting on load. The very
    // first snapshot from useSnapshot is the empty placeholder (no agents); if we
    // primed on that, every already-waiting agent in the first real snapshot
    // would count as a fresh transition and fire. The board primes the same way.
    if (snap.agents.length > 0) primed.current = true;
    if (snap.board.cards.length > 0) boardPrimed.current = true;
  }, [snap, enabled]);

  return null;
}
