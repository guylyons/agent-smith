import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../lib/snapshot";

const STORAGE_KEY = "aw-alerts";

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveEnabled(v: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// Short two-tone beep, synthesized with WebAudio so we don't ship an audio
// asset. Best-effort: browsers can block audio without a prior user gesture.
function playBeep() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const tones = [
      { freq: 880, start: 0, dur: 0.12 },
      { freq: 1320, start: 0.13, dur: 0.14 },
    ];
    for (const t of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = t.freq;
      gain.gain.setValueAtTime(0.0001, now + t.start);
      gain.gain.exponentialRampToValueAtTime(0.15, now + t.start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + t.start);
      osc.stop(now + t.start + t.dur + 0.02);
    }
    // Tear the context down once the tones finish playing.
    setTimeout(() => {
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
    }, 400);
  } catch {
    /* autoplay/AudioContext may be blocked — ignore */
  }
}

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

export function Notifier({ snap }: { snap: Snapshot }) {
  const [enabled, setEnabled] = useState(false);
  const prevWaiting = useRef<Map<string, boolean>>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    setEnabled(loadEnabled());
  }, []);

  useEffect(() => {
    const prev = prevWaiting.current;
    const next = new Map<string, boolean>();

    for (const agent of snap.agents) {
      const isWaiting = agent.state === "waiting";
      next.set(agent.sessionId, isWaiting);

      if (primed.current && isWaiting && !prev.get(agent.sessionId)) {
        // Transitioned into waiting since the last snapshot.
        if (enabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
          notify(agent.name, agent.waitingReason, agent.doing);
          playBeep();
        }
      }
    }

    prevWaiting.current = next;
    // Establish the baseline on the very first snapshot without firing, so we
    // don't alert for every agent that's already waiting on load.
    primed.current = true;
  }, [snap, enabled]);

  function toggle() {
    const next = !enabled;
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    setEnabled(next);
    saveEnabled(next);
  }

  return (
    <button className="alertbtn" aria-live="polite" onClick={toggle}>
      🔔 ALERTS: {enabled ? "ON" : "OFF"}
    </button>
  );
}
