// Tiny non-blocking toast bus (replaces alert()). Components subscribe; anything
// can push a message.
//
// A toast may carry one ACTION — a labelled button the Toaster renders inline.
// That's what makes a destructive edit safe without a blocking confirm(): do the
// thing immediately, then offer "UNDO" for as long as the toast is up.
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; text: string; action?: ToastAction };

let seq = 0;
const listeners = new Set<(t: Toast) => void>();

export function toast(text: string, action?: ToastAction): void {
  const t: Toast = { id: ++seq, text, ...(action ? { action } : {}) };
  for (const l of listeners) l(t);
}

export function subscribeToasts(cb: (t: Toast) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
