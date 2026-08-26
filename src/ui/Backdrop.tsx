import { useEffect, useState } from "react";

// Self-contained 2D-art backgrounds (pure CSS, no external assets). The chosen
// one is applied via <html data-bg="…"> (kept separate from the CRT's className)
// and remembered in localStorage.
const BGS = [
  { id: "night", label: "BG: NIGHT" },
  { id: "stars", label: "BG: STARS" },
  { id: "synth", label: "BG: SYNTH" },
  { id: "grid", label: "BG: GRID" },
  { id: "dusk", label: "BG: DUSK" },
] as const;

function apply(id: string) {
  document.documentElement.dataset.bg = id;
}

export function Backdrop() {
  const [i, setI] = useState(0);

  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("aw-bg"); } catch { /* private mode */ }
    const idx = Math.max(0, BGS.findIndex((b) => b.id === saved));
    apply(BGS[idx].id);
    setI(idx);
  }, []);

  function cycle() {
    const next = (i + 1) % BGS.length;
    apply(BGS[next].id);
    try { localStorage.setItem("aw-bg", BGS[next].id); } catch { /* ignore */ }
    setI(next);
  }

  return (
    <>
      <div className="artbg" aria-hidden="true"></div>
      <button className="bgbtn" aria-live="polite" onClick={cycle}>{BGS[i].label}</button>
    </>
  );
}
