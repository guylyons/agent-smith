// Tiny bus for the tube death. Stopping an agent (drawer ◼, desk ✕) fires
// signalDying(sessionId); the drawer you clicked in and the crew card for that
// id both play the CRT power-off, then get pulled. Mirrors flash.ts.
const listeners = new Set<(sessionId: string) => void>();

export function signalDying(sessionId: string): void {
  for (const l of listeners) l(sessionId);
}

export function subscribeDying(cb: (sessionId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** How long to hold a dying window on screen. The full glitch runs 1.5s (see
 *  @keyframes tube-die); reduced motion gets a plain fade instead — the whole
 *  animation is stripped there — so it waits only as long as that fade. */
export function dyingMs(): number {
  const reduced = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? 300 : 1500;
}
