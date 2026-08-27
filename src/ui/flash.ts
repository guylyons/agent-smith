// Tiny bus that pulses an agent's grid card when input is sent to it. Any send
// site (chat, question answer, card task) fires flashSend(sessionId); the crew
// card with that id subscribes and briefly rings itself green. Mirrors toast.ts.
const listeners = new Set<(sessionId: string) => void>();

export function flashSend(sessionId: string): void {
  for (const l of listeners) l(sessionId);
}

export function subscribeFlash(cb: (sessionId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
