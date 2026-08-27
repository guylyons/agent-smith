import { useState } from "react";
import { ModalBackdrop } from "./Backdrop";
import { TUBE_MODES, BACKGROUNDS, applyTube, applyBg, loadSetting, saveSetting } from "./settings";

// One place for the display/alert toggles that used to float over the board.
export function SettingsPanel({ alertsEnabled, onToggleAlerts, onClose }: {
  alertsEnabled: boolean; onToggleAlerts: () => void; onClose: () => void;
}) {
  const [tube, setTube] = useState(() => loadSetting("aw-tube", ""));
  const [bg, setBg] = useState(() => loadSetting("aw-bg", "night"));

  function pickTube(cls: string) { applyTube(cls); saveSetting("aw-tube", cls); setTube(cls); }
  function pickBg(id: string) { applyBg(id); saveSetting("aw-bg", id); setBg(id); }

  return (
    <ModalBackdrop onClose={onClose}>
      <aside className="win settings">
        <div className="settings-head">
          <span className="pix settings-title">SETTINGS</span>
          <button className="deskbtn" title="Close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="pix settings-label">DISPLAY · CRT</div>
          <div className="settings-row">
            {TUBE_MODES.map((m) => (
              <button key={m.cls} className={`deskbtn ${tube === m.cls ? "on" : ""}`} onClick={() => pickTube(m.cls)}>{m.label}</button>
            ))}
          </div>

          <div className="pix settings-label">BACKGROUND</div>
          <div className="settings-row">
            {BACKGROUNDS.map((b) => (
              <button key={b.id} className={`deskbtn ${bg === b.id ? "on" : ""}`} onClick={() => pickBg(b.id)}>{b.label}</button>
            ))}
          </div>

          <div className="pix settings-label">ALERTS</div>
          <div className="settings-row">
            <button className={`deskbtn ${alertsEnabled ? "on" : ""}`} onClick={onToggleAlerts}>🔔 {alertsEnabled ? "ON" : "OFF"}</button>
          </div>
          <div className="pix settings-hint">A desktop notification + sound when an agent needs you.</div>
        </div>
      </aside>
    </ModalBackdrop>
  );
}
