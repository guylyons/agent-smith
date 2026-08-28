import { useEffect, useRef, useState } from "react";
import type { CrtMode } from "./settings";

// The CRT tube stack. Strength comes from <html data-crt> (off/soft/on/max),
// which the Settings panel sets; this renders the layers, back to front:
//
//   scan     horizontal scanlines (the raster)
//   grille   the vertical RGB triad of an aperture-grille tube
//   bloom    phosphor halation — bright areas bleeding into the glass
//   glow     tube glow at the top + the corner falloff of a curved face
//   bezel    the rounded tube face itself, with its dark edge and glass rim
//   glare    a soft diagonal reflection on the glass
//   hum      the slow brightness bar drifting down an un-synced tube
//
// All of it is pointer-events:none and aria-hidden — it is pure decoration over
// a normal DOM, so nothing here can catch a click or reach a screen reader.
// Every animated layer is stripped under prefers-reduced-motion (styles.css).

// How long the power-on sweep plays. Matches the crt-power animation.
const BOOT_MS = 900;

export function Crt({ mode }: { mode: CrtMode }) {
  // A power-on sweep when the tube is switched on (or made stronger) — not on
  // first paint, which would flash the screen on every reload.
  const [boot, setBoot] = useState(0);
  const prev = useRef<CrtMode | null>(null);

  useEffect(() => {
    const was = prev.current;
    prev.current = mode;
    if (was === null || mode === "off" || mode === was) return;
    setBoot((n) => n + 1);
    const t = setTimeout(() => setBoot(0), BOOT_MS);
    return () => clearTimeout(t);
  }, [mode]);

  if (mode === "off") return null;

  return (
    <div className="crt-stack" aria-hidden="true">
      <div className="crt crt-scan"></div>
      <div className="crt crt-grille"></div>
      <div className="crt crt-bloom"></div>
      <div className="crt crt-glow"></div>
      <div className="crt crt-bezel"></div>
      <div className="crt crt-glare"></div>
      <div className="crt crt-hum"></div>
      {boot > 0 && <div key={boot} className="crt crt-power"></div>}
    </div>
  );
}
