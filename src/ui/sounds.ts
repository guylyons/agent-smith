// Chiptune sound cues, synthesized with WebAudio so we ship no audio assets and
// stay in the SNES/CRT register. All best-effort: browsers can block audio until
// a user gesture, and every call is wrapped so a blocked/unsupported context is a
// silent no-op, never an error.
//
// The *decision* of which cue to play lives in soundEvents.ts (pure, tested);
// this module is just the synth and can't be unit-tested under bun.

import type { SoundCue } from "./soundEvents";

type Note = { freq: number; start: number; dur: number };

// One shared AudioContext, created lazily on first use and reused. Creating a
// context per sound is wasteful and can hit per-page context limits.
let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!ctx) ctx = new Ctx();
    // A context created before a user gesture starts "suspended"; resume is
    // best-effort and becomes a no-op once the browser allows audio.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

// Play a sequence of square-wave notes with a short attack/decay envelope each.
function playSequence(notes: Note[]): void {
  const c = audioCtx();
  if (!c) return;
  try {
    const now = c.currentTime;
    for (const n of notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "square";
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0.0001, now + n.start);
      gain.gain.exponentialRampToValueAtTime(0.15, now + n.start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.02);
    }
  } catch {
    /* autoplay/AudioContext may be blocked — ignore */
  }
}

// A resolving ascending arpeggio — "task done".
export function playCompletion(): void {
  playSequence([
    { freq: 660, start: 0, dur: 0.1 },
    { freq: 880, start: 0.09, dur: 0.1 },
    { freq: 1320, start: 0.18, dur: 0.16 },
  ]);
}

// A rising two-tone "?" — inquisitive, distinct from the permission beep.
export function playQuestion(): void {
  playSequence([
    { freq: 587, start: 0, dur: 0.11 },
    { freq: 988, start: 0.12, dur: 0.16 },
  ]);
}

// The original two-tone beep, kept so permission prompts stay recognizable.
export function playPermission(): void {
  playSequence([
    { freq: 880, start: 0, dur: 0.12 },
    { freq: 1320, start: 0.13, dur: 0.14 },
  ]);
}

// A short single blip acknowledging a user send.
export function playSubmit(): void {
  playSequence([{ freq: 1046, start: 0, dur: 0.07 }]);
}

// A quick two-tick "slide" — a card moving between columns. Deliberately short
// and light: this fires on every board move, so it must never feel heavy.
export function playMove(): void {
  playSequence([
    { freq: 523, start: 0, dur: 0.05 },
    { freq: 784, start: 0.05, dur: 0.06 },
  ]);
}

// A triumphant four-note fanfare — a task reaching Done. Longer and brighter
// than the plain completion arpeggio so a finished ticket lands as an event.
export function playCelebrate(): void {
  playSequence([
    { freq: 523, start: 0, dur: 0.1 },
    { freq: 659, start: 0.1, dur: 0.1 },
    { freq: 784, start: 0.2, dur: 0.1 },
    { freq: 1046, start: 0.3, dur: 0.22 },
  ]);
}

// Play the cue named by a SoundCue value (from soundTransitions / boardMoves).
export function playCue(cue: SoundCue): void {
  if (cue === "completion") playCompletion();
  else if (cue === "question") playQuestion();
  else if (cue === "move") playMove();
  else if (cue === "celebrate") playCelebrate();
  else playPermission();
}
