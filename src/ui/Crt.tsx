import { useState } from "react";

const MODES = [
  { cls: "", label: "TUBE: CRT" },
  { cls: "crt-soft", label: "TUBE: SOFT" },
  { cls: "crt-off", label: "TUBE: OFF" },
] as const;

export function Crt() {
  const [mode, setMode] = useState(0);

  function cycle() {
    const next = (mode + 1) % MODES.length;
    document.documentElement.className = MODES[next].cls;
    setMode(next);
  }

  return (
    <>
      <button className="tube" aria-live="polite" onClick={cycle}>
        {MODES[mode].label}
      </button>

      <div className="crt crt-scan"></div>
      <div className="crt crt-grille"></div>
      <div className="crt crt-glow"></div>
      <div className="crt crt-hum"></div>
    </>
  );
}
