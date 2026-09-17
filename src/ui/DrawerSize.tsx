// The two things the conversation drawer lets you change about itself: how wide
// it is, and how big its text is. Both are kept out of the Settings panel on
// purpose — you want them while you are reading a transcript, not two screens
// away — and both are persisted, so the drawer opens the way you left it.
//
// Neither value lives in ConversationDrawer's state. They are custom properties
// on <html>, written by these two small components, so dragging the edge does
// not re-render a thousand-message transcript sixty times a second.
import { useEffect, useRef, useState } from "react";
import {
  KEYS, saveSetting,
  clampDrawerWidth, applyDrawerWidth, loadDrawerWidth,
  clampDrawerFont, applyDrawerFont, loadDrawerFont,
  DRAWER_W_MIN, DRAWER_W_MAX, DRAWER_W_DEFAULT,
  DRAWER_FONT_MIN, DRAWER_FONT_MAX, DRAWER_FONT_DEFAULT, DRAWER_FONT_STEP,
} from "./settings";

/** One arrow key, and one shift+arrow, in px. */
const STEP = 24;
const BIG_STEP = 96;

/** The drag handle on the drawer's left edge.
 *
 *  Pointer events with capture rather than window listeners: the pointer leaves
 *  the 10px strip on the first move, and capture keeps the stream coming
 *  without a mousemove handler on the document.
 *
 *  It is a real `separator` widget, not a bare div: it takes focus, and the
 *  arrow keys resize in `STEP`s so the drawer can be sized without a mouse. */
export function DrawerResizer() {
  const [width, setWidth] = useState(loadDrawerWidth);
  const [dragging, setDragging] = useState(false);
  // The pointer handlers need the newest width without waiting for a render.
  const widthRef = useRef(width);

  const set = (px: number) => {
    const next = clampDrawerWidth(px);
    widthRef.current = next;
    applyDrawerWidth(next);
    setWidth(next);
  };
  const commit = () => saveSetting(KEYS.drawerWidth, String(widthRef.current));

  // A live drag needs the resize cursor and the selection block across the
  // whole window, not just the handle the pointer has already left behind.
  useEffect(() => {
    document.documentElement.classList.toggle("is-resizing", dragging);
    return () => document.documentElement.classList.remove("is-resizing");
  }, [dragging]);

  return (
    <div
      className={`drawer-resizer${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Drawer width"
      aria-valuenow={width}
      aria-valuemin={DRAWER_W_MIN}
      aria-valuemax={DRAWER_W_MAX}
      aria-valuetext={`${width} pixels wide`}
      tabIndex={0}
      title="Drag to resize · ← → to nudge · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();            // don't begin a text selection in the transcript
        e.currentTarget.focus();       // ...but do take focus, so ← → work straight after
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      // The drawer is anchored to the right edge, so its width is simply how
      // much window is left of the pointer.
      onPointerMove={(e) => { if (dragging) set(window.innerWidth - e.clientX); }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        commit();
      }}
      onPointerCancel={() => { if (dragging) { setDragging(false); commit(); } }}
      onDoubleClick={() => { set(DRAWER_W_DEFAULT); commit(); }}
      onKeyDown={(e) => {
        // Anchored right: LEFT grows the drawer, RIGHT shrinks it.
        const step = e.shiftKey ? BIG_STEP : STEP;
        if (e.key === "ArrowLeft") set(widthRef.current + step);
        else if (e.key === "ArrowRight") set(widthRef.current - step);
        else if (e.key === "Home") set(DRAWER_W_MIN);
        else if (e.key === "End") set(DRAWER_W_MAX);
        else if (e.key === "Enter") set(DRAWER_W_DEFAULT);
        else return;
        e.preventDefault();
        commit();
      }}
    >
      <span className="drawer-grip" aria-hidden="true"></span>
    </div>
  );
}

/** A− / A+ for the drawer's text. The middle button shows the current size and
 *  puts it back to the default, which is the only way back from a size you
 *  can't read the buttons at.
 *
 *  `onChange` is a notification, not a second home for the value: the composer
 *  sets its own height in JS and has to remeasure when the text it holds gets
 *  bigger. */
export function DrawerZoom({ onChange }: { onChange?: (px: number) => void }) {
  const [size, setSize] = useState(loadDrawerFont);
  // Stepping reads the CURRENT size, not the one this render closed over: two
  // fast clicks land in the same React batch and the second would otherwise
  // repeat the first step instead of adding to it.
  const sizeRef = useRef(size);

  const set = (px: number) => {
    const next = clampDrawerFont(px);
    sizeRef.current = next;
    applyDrawerFont(next);
    saveSetting(KEYS.drawerFont, String(next));
    setSize(next);
    onChange?.(next);
  };

  return (
    <div className="drawer-zoom" role="group" aria-label="Text size">
      <button className="zoombtn" title="Smaller text" aria-label="Smaller text"
        disabled={size <= DRAWER_FONT_MIN}
        onClick={() => set(sizeRef.current - DRAWER_FONT_STEP)}>A−</button>
      <button className="zoombtn zoomval" title="Reset text size"
        aria-label={`Text size ${size} pixels — click to reset`}
        onClick={() => set(DRAWER_FONT_DEFAULT)}>{size}</button>
      <button className="zoombtn" title="Larger text" aria-label="Larger text"
        disabled={size >= DRAWER_FONT_MAX}
        onClick={() => set(sizeRef.current + DRAWER_FONT_STEP)}>A+</button>
    </div>
  );
}
