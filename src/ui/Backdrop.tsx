import { useRef, type ReactNode } from "react";

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

// A dimmed modal backdrop that closes on a genuine backdrop click. A plain
// onClick={onClose} misfires when a text selection begins inside the panel and
// the mouse is released over the backdrop: the click's target is then the
// backdrop, so the modal closes and any unsaved input is lost. Close only when
// BOTH the mousedown and the click landed on the backdrop itself — so a
// drag-select that ends outside the panel no longer dismisses it.
export function ModalBackdrop({ className = "drawer-backdrop", onClose, children }: {
  className?: string; onClose: () => void; children: ReactNode;
}) {
  const downOnSelf = useRef(false);
  return (
    <div
      className={className}
      onMouseDown={(e) => { downOnSelf.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnSelf.current) onClose(); }}
    >
      {children}
    </div>
  );
}
