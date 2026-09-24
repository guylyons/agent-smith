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


// A mechanical key click — a short noise burst through a band-pass, not a
// square wave: a keycap bottoming out is a clack, and the chiptune blips we use
// elsewhere don't sound like hardware. `down` is the heavier press; the release
// is the same click a touch higher and quieter, so pressing and letting go
// reads as one physical action.
export function playKeyClick(down: boolean): void {
  const c = audioCtx();
  if (!c) return;
  try {
    const dur = down ? 0.035 : 0.022;
    const buf = c.createBuffer(1, Math.max(1, Math.ceil(c.sampleRate * dur)), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // white noise under a steep decay — all the energy is in the first few ms
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const band = c.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = down ? 2200 : 3200;
    band.Q.value = 1.2;
    const gain = c.createGain();
    gain.gain.value = down ? 0.22 : 0.12;
    src.connect(band);
    band.connect(gain);
    gain.connect(c.destination);
    src.start();
  } catch {
    /* autoplay/AudioContext may be blocked — ignore */
  }
}

// The tube death (see @keyframes tube-die): a CRT losing its signal and
// switching off. Timed to the 1.5s animation — crackling static through the
// glitch frames, a rising flyback whine as the phosphor flares, then the
// "thoop" of the picture collapsing to a dot, and a click as it goes.
// `short` is the reduced-motion version: the window only fades for 0.3s there,
// so it gets just the collapse and the click. While one is still playing, a
// new death doesn't start another — overlapping copies just pile up into
// noise — it only adds the final click, so a second death is still heard.
// Each click holds the gate a little longer, so a steady run of deaths (cards
// dragged to Done in a row) stays one sound plus clicks. Deaths in the same
// snapshot (under 0.25s apart) get nothing extra.
export type TubeOffState = { busyUntil: number; lastAt: number };
export type TubeOffPlay = "full" | "click" | "none";

// Pure timing rule for playTubeOff; `now` is AudioContext time in seconds.
export function tubeOffGate(
  now: number,
  state: TubeOffState,
  short: boolean,
): { play: TubeOffPlay; state: TubeOffState } {
  if (now >= state.busyUntil) {
    return { play: "full", state: { busyUntil: now + (short ? 0.3 : 1.5), lastAt: now } };
  }
  if (now - state.lastAt < 0.25) return { play: "none", state };
  const tail = short ? 0.3 : 0.5;
  return { play: "click", state: { busyUntil: Math.max(state.busyUntil, now + tail), lastAt: now } };
}

// The dot going out: one tiny click at `when` into `out`.
function tubeClick(c: AudioContext, out: AudioNode, when: number): void {
  const click = c.createBuffer(1, Math.ceil(c.sampleRate * 0.012), c.sampleRate);
  const cd = click.getChannelData(0);
  for (let i = 0; i < cd.length; i++) cd[i] = (Math.random() * 2 - 1) * (1 - i / cd.length) ** 4;
  const cs = c.createBufferSource();
  cs.buffer = click;
  const cg = c.createGain();
  cg.gain.value = 0.25;
  cs.connect(cg);
  cg.connect(out);
  cs.start(when);
}

let tubeOff: TubeOffState = { busyUntil: 0, lastAt: -Infinity };
export function playTubeOff(short = false): void {
  const c = audioCtx();
  if (!c) return;
  const gate = tubeOffGate(c.currentTime, tubeOff, short);
  tubeOff = gate.state;
  if (gate.play === "none") return;
  if (gate.play === "click") {
    try {
      const out = c.createGain();
      out.gain.value = 0.5;
      out.connect(c.destination);
      tubeClick(c, out, c.currentTime);
    } catch {
      /* autoplay/AudioContext may be blocked — ignore */
    }
    return;
  }
  try {
    const now = c.currentTime;
    const out = c.createGain();
    out.gain.value = 0.5;
    out.connect(c.destination);

    // Static: noise whose loudness jumps between frames, like the steps() in
    // the glitch keyframes, and gutters out as the picture does (to ~66%).
    const staticEnd = short ? 0 : 1.0;
    if (staticEnd > 0) {
      const len = Math.ceil(c.sampleRate * staticEnd);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const data = buf.getChannelData(0);
      const frame = Math.ceil(c.sampleRate * 0.045);
      let level = 0;
      for (let i = 0; i < len; i++) {
        if (i % frame === 0) level = Math.random() < 0.3 ? 0.15 : 0.4 + Math.random() * 0.6;
        const fade = 1 - (i / len) ** 2;
        data[i] = (Math.random() * 2 - 1) * level * fade;
      }
      const src = c.createBufferSource();
      src.buffer = buf;
      const hp = c.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1400;
      const g = c.createGain();
      g.gain.value = 0.16;
      src.connect(hp);
      hp.connect(g);
      g.connect(out);
      src.start(now);
    }

    // Flyback whine rising into the flare, then the collapse: a sine that
    // dives from high to a low thump as the image shrinks to a line.
    const t0 = now + (short ? 0 : 1.0);
    const whine = c.createOscillator();
    const wg = c.createGain();
    whine.type = "triangle";
    whine.frequency.setValueAtTime(short ? 1800 : 900, t0);
    if (!short) whine.frequency.exponentialRampToValueAtTime(2400, t0 + 0.18);
    whine.frequency.exponentialRampToValueAtTime(55, t0 + (short ? 0.26 : 0.46));
    wg.gain.setValueAtTime(0.0001, t0);
    wg.gain.exponentialRampToValueAtTime(0.18, t0 + 0.03);
    wg.gain.setValueAtTime(0.18, t0 + (short ? 0.06 : 0.2));
    wg.gain.exponentialRampToValueAtTime(0.0001, t0 + (short ? 0.28 : 0.5));
    whine.connect(wg);
    wg.connect(out);
    whine.start(t0);
    whine.stop(t0 + (short ? 0.3 : 0.52));

    // The dot going out: one tiny click.
    tubeClick(c, out, t0 + (short ? 0.28 : 0.48));
  } catch {
    /* autoplay/AudioContext may be blocked — ignore */
  }
}

// Play the cue named by a SoundCue value (from soundTransitions / boardMoves).
export function playCue(cue: SoundCue): void {
  if (cue === "completion") playCompletion();
  else if (cue === "question") playQuestion();
  else if (cue === "move") playMove();
  else if (cue === "celebrate") playCelebrate();
  else playPermission();
}
