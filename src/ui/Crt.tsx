import { useEffect, useRef, useState } from "react";
import type { BevelMode, CrtMode } from "./settings";

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

// The tube bevel: the moulded glass front of a real TV set, sitting in front of
// everything the CRT stack draws. Thickness comes from <html data-bevel>
// (off/slim/thick). Four layers, back to front:
//
//   surround  the dark set beyond the glass, filling the four rounded corners
//   glass     the light direction — lit top-left, falling into shadow bottom-right
//   inner     the seam where glass meets picture, and the chamfer's own shading
//   shine     the specular hit a window leaves on curved glass
//
// Independent of the CRT setting on purpose: you can have the glass without the
// scanlines, or the scanlines without the glass. Inert like the CRT stack —
// pointer-events:none and aria-hidden, so it is decoration and nothing more.
// Nothing here moves, so there is nothing for reduced-motion to strip.
export function TubeBevel({ mode }: { mode: BevelMode }) {
  if (mode === "off") return null;
  return (
    <div className="bev-stack" aria-hidden="true">
      <div className="bev bev-surround"></div>
      <div className="bev bev-glass"></div>
      <div className="bev bev-inner"></div>
      <div className="bev bev-shine"></div>
    </div>
  );
}
