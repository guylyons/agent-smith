import { useEffect, useRef, useState, type ReactNode } from "react";

// The art-background layers, all behind the page (z-index:-1):
//
//   artbg         the chosen art background, or the user's own uploaded image
//   artbg-scrim   a per-THEME wash — how a light theme keeps the art from
//                 fighting its dark text, without the user having to touch it
//   artbg-dim     the user's own DIM slider, always plain black
//
// Two separate layers because they answer to different owners: switching themes
// must not throw away a dim the user set, and dragging the dim slider must not
// undo the theme's wash. Which background is showing comes from <html data-bg>.
export function Backdrop() {
  return (
    <>
      <div className="artbg" aria-hidden="true"></div>
      <div className="artbg-scrim" aria-hidden="true"></div>
      <div className="artbg-dim" aria-hidden="true"></div>
    </>
  );
}

// Where Tab should go inside a dialog, or null to let the browser move focus.
// `index` is the focused control's place among the dialog's `count` tabbable
// controls (-1 when focus is on none of them). Wraps at both ends so Tab and
// Shift+Tab never leave the dialog.
export function trapIndex(count: number, index: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (index === -1) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

// Whether an Esc keydown should close the dialog. Only the top dialog closes,
// and never when something inside already handled the key (preventDefault) or
// an IME is mid-composition, where Esc cancels the composition instead.
export function escCloses(e: { key: string; defaultPrevented: boolean; isComposing: boolean }, isTop: boolean): boolean {
  return e.key === "Escape" && isTop && !e.defaultPrevented && !e.isComposing;
}

// Where focus goes when a dialog closes, or null to leave it where it is.
// Only moves focus that was lost with the dialog (`focusLost`: it was inside
// the dialog, or already dropped to the page): if something else took focus
// meanwhile, such as a dialog that opened as this one closed, it stays there.
// Takes the first candidate still on the page, in order: the control that
// opened the dialog, the dialog's own fallback (the card's button on the
// board), then the dialog now on top. The opener is often gone by then: a FIND
// row or a notice that opened a card unmounts as it does, and a card that
// changed column is a fresh button in its new column.
export function returnTarget<T extends { isConnected: boolean }>(
  focusLost: boolean, candidates: (T | null | undefined)[],
): T | null {
  if (!focusLost) return null;
  return candidates.find((c): c is T => !!c && c.isConnected) ?? null;
}

const TABBABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)]
    .filter((el) => el.tabIndex >= 0 && !el.hidden && el.getClientRects().length > 0);
}

// Open dialogs, innermost last: only the top one traps Tab.
const openDialogs: HTMLElement[] = [];

// A dimmed modal backdrop that closes on a genuine backdrop click. A plain
// onClick={onClose} misfires when a text selection begins inside the panel and
// the mouse is released over the backdrop: the click's target is then the
// backdrop, so the modal closes and any unsaved input is lost. Close only when
// BOTH the mousedown and the click landed on the backdrop itself — so a
// drag-select that ends outside the panel no longer dismisses it.
//
// Given a name (`labelledBy`, the id of the dialog's title, or `label`), it is
// also a modal dialog: announced as one, focus moves in on open (unless the
// dialog already focused a field of its own), Tab cycles inside, Esc calls
// onClose, and on close focus goes back to whatever opened it, or, when that
// is gone, to `returnTo()` or the dialog underneath (see returnTarget).
export function ModalBackdrop({ className = "drawer-backdrop", onClose, labelledBy, label, returnTo, children }: {
  className?: string; onClose: () => void; labelledBy?: string; label?: string;
  returnTo?: () => HTMLElement | null; children: ReactNode;
}) {
  const downOnSelf = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, so the key listener below needn't resubscribe per render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const returnToRef = useRef(returnTo);
  returnToRef.current = returnTo;
  const isDialog = Boolean(labelledBy || label);
  // Read during the first render, before any autoFocus inside has moved focus.
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement));

  useEffect(() => {
    const root = ref.current;
    if (!isDialog || !root) return;
    openDialogs.push(root);
    if (!root.contains(document.activeElement)) (tabbables(root)[0] ?? root).focus();

    function onKey(e: KeyboardEvent) {
      const isTop = openDialogs[openDialogs.length - 1] === root;
      if (escCloses(e, isTop)) { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab" || !isTop) return;
      const list = tabbables(root!);
      const to = trapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (to === null) return;
      e.preventDefault();
      list[to]!.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openDialogs.splice(openDialogs.indexOf(root), 1);
      const active = document.activeElement;
      const lost = !active || active === document.body || root.contains(active);
      const top = openDialogs[openDialogs.length - 1];
      const to = returnTarget(lost, [
        opener instanceof HTMLElement && opener !== document.body ? opener : null,
        returnToRef.current?.(),
        top && (tabbables(top)[0] ?? top),
      ]);
      to?.focus();
    };
  }, [isDialog]);

  return (
    <div
      ref={ref}
      className={className}
      {...(isDialog && { role: "dialog", "aria-modal": true, "aria-labelledby": labelledBy, "aria-label": label, tabIndex: -1 })}
      onMouseDown={(e) => { downOnSelf.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnSelf.current) onClose(); }}
    >
      {children}
    </div>
  );
}
