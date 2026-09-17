// Tiny non-blocking toast bus (replaces alert()). Components subscribe; anything
// can push a message.
//
// A toast may carry one ACTION — a labelled button the Toaster renders inline.
// That's what makes a destructive edit safe without a blocking confirm(): do the
// thing immediately, then offer "UNDO" for as long as the toast is up.
export type ToastAction = { label: string; run: () => void };
// "error" toasts get a more assertive screen-reader announcement (Toaster.tsx)
// since a failed action is time-sensitive information the user might otherwise
// never learn about; anything else — confirmations, the delete/undo offer — is
// routine status and stays polite.
export type Toast = { id: number; text: string; kind?: "error"; action?: ToastAction };

let seq = 0;
const listeners = new Set<(t: Toast) => void>();

function push(text: string, kind: Toast["kind"], action?: ToastAction): void {
  const t: Toast = { id: ++seq, text, ...(kind ? { kind } : {}), ...(action ? { action } : {}) };
  for (const l of listeners) l(t);
}

export function toast(text: string, action?: ToastAction): void {
  push(text, undefined, action);
}

/** A failed action, surfaced with a more assertive screen-reader announcement. */
export function toastError(text: string): void {
  push(text, "error");
}

export function subscribeToasts(cb: (t: Toast) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
