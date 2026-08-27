import { useEffect, useRef } from "react";
import type { Snapshot } from "../lib/snapshot";
import { soundTransitions, type PrevState } from "./soundEvents";
import { playCue } from "./sounds";

function notify(name: string, waitingReason: "permission" | "question" | undefined, doing: string) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const body = waitingReason ?? doing;
    new Notification(`${name} needs you`, { body });
  } catch {
    /* ignore */
  }
}

// Fires sound cues (completion / question / permission) and a desktop
// notification when agents change state. Renders nothing — the on/off control
// lives in the Settings panel (App owns it). The which-cue decision is the pure
// soundTransitions() (see soundEvents.ts); this effect just plays and notifies.
export function Notifier({ snap, enabled }: { snap: Snapshot; enabled: boolean }) {
  const prevState = useRef<PrevState>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    const prev = prevState.current;
    const { cues, next } = soundTransitions(prev, snap.agents, primed.current);

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

    prevState.current = next;
    // Establish the baseline on the first POPULATED snapshot without firing, so
    // we don't alert for every agent that's already waiting on load. The very
    // first snapshot from useSnapshot is the empty placeholder (no agents); if we
    // primed on that, every already-waiting agent in the first real snapshot
    // would count as a fresh transition and fire.
    if (snap.agents.length > 0) primed.current = true;
  }, [snap, enabled]);

  return null;
}
