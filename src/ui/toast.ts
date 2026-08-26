// Tiny non-blocking toast bus (replaces alert()). Components subscribe; anything
// can push a message.
export type Toast = { id: number; text: string };

let seq = 0;
const listeners = new Set<(t: Toast) => void>();

export function toast(text: string): void {
  const t = { id: ++seq, text };
  for (const l of listeners) l(t);
}

export function subscribeToasts(cb: (t: Toast) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
