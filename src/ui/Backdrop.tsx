import { useRef, type ReactNode } from "react";

// The art-background layer. The chosen background is applied to <html data-bg>
// by the Settings panel (and on load by App); this just renders the layer.
export function Backdrop() {
  return <div className="artbg" aria-hidden="true"></div>;
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
