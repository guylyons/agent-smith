import { useRef, useState } from "react";
import { ModalBackdrop } from "./Backdrop";
import {
  THEMES, CRT_MODES, BEVEL_MODES, BACKGROUNDS, CUSTOM_BG,
  LINE_ROWS_MIN, LINE_ROWS_MAX, LINE_ROWS_OFF,
  type BevelMode, type CrtMode, type Display,
} from "./settings";
import { uploadImage } from "./actions";
import { toast } from "./toast";

// How far a freshly uploaded wallpaper is dimmed, so the UI is readable over it
// from the first frame. The user can take it straight back to 0.
const DEFAULT_CUSTOM_DIM = 35;

// One place for the display/alert controls. The values live in App (the CRT
// overlay needs the mode too), so this panel only renders them and reports a
// patch back — every change applies live, nothing to save.
export function SettingsPanel({ display, onChange, alertsEnabled, onToggleAlerts, face, onToggleFace, onClose }: {
  display: Display;
  onChange: (patch: Partial<Display>) => void;
  alertsEnabled: boolean;
  onToggleAlerts: () => void;
  face: boolean;
  onToggleFace: () => void;
  onClose: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const theme = THEMES.find((t) => t.id === display.theme) ?? THEMES[0];

  // The chosen file is uploaded like any other image and served back from
  // /uploads, so only its short URL goes to localStorage — a multi-megabyte
  // data: URL would blow the storage quota on the first wallpaper.
  async function pickImage(file: File) {
    setUploading(true);
    const up = await uploadImage(file);
    setUploading(false);
    if (!up) return; // uploadImage already toasted why
    // A photo behind the UI is far more likely to fight the text than the built-in
    // art is, so the first wallpaper arrives with a readable amount of dim already
    // dialled in. Only ever seeded — if the user has set a dim, theirs stands.
    const seedDim = !display.bgImage && display.bgDim === 0 ? { bgDim: DEFAULT_CUSTOM_DIM } : {};
    onChange({ bgImage: up.url, bg: CUSTOM_BG, ...seedDim });
    toast("Background updated");
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <aside className="win settings">
        <div className="settings-head">
          <span className="pix settings-title">CONFIG</span>
          <button className="deskbtn" title="Close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="pix settings-label">THEME</div>
          <div className="settings-row">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`deskbtn ${display.theme === t.id ? "on" : ""}`}
                aria-pressed={display.theme === t.id}
                onClick={() => onChange({ theme: t.id })}
              >{t.label}</button>
            ))}
          </div>
          <div className="pix settings-hint">{theme.hint}</div>

          <div className="pix settings-label">DISPLAY · CRT</div>
          <div className="settings-row">
            {CRT_MODES.map((m) => (
              <button
                key={m.id}
                className={`deskbtn ${display.crt === m.id ? "on" : ""}`}
                aria-pressed={display.crt === m.id}
                onClick={() => onChange({ crt: m.id as CrtMode })}
              >{m.label}</button>
            ))}
          </div>
          <div className="pix settings-hint">
            Scanlines, aperture grille, phosphor bloom and a curved tube face. MAX adds the roll bar and flicker.
          </div>

          <div className="pix settings-label">DISPLAY · BEVEL</div>
          <div className="settings-row">
            {BEVEL_MODES.map((m) => (
              <button
                key={m.id}
                className={`deskbtn ${display.bevel === m.id ? "on" : ""}`}
                aria-pressed={display.bevel === m.id}
                onClick={() => onChange({ bevel: m.id as BevelMode })}
              >{m.label}</button>
            ))}
          </div>
          <div className="pix settings-hint">
            Puts the screen behind moulded glass: rounded corners, a lit chamfer round the edge and the picture bending away into it. Works with the CRT setting or on its own.
          </div>

          <div className="pix settings-label">BACKGROUND</div>
          <div className="settings-row">
            {BACKGROUNDS.map((b) => (
              <button
                key={b.id}
                className={`deskbtn ${display.bg === b.id ? "on" : ""}`}
                aria-pressed={display.bg === b.id}
                onClick={() => onChange({ bg: b.id })}
              >{b.label}</button>
            ))}
            {/* Only offered once there's an image to go back to. */}
            {display.bgImage && (
              <button
                className={`deskbtn ${display.bg === CUSTOM_BG ? "on" : ""}`}
                aria-pressed={display.bg === CUSTOM_BG}
                onClick={() => onChange({ bg: CUSTOM_BG })}
              >MINE</button>
            )}
          </div>

          <div className="settings-row settings-bgfile">
            <button className="deskbtn" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "UPLOADING…" : display.bgImage ? "🖼 REPLACE IMAGE…" : "🖼 UPLOAD IMAGE…"}
            </button>
            {display.bgImage && (
              <button
                className="deskbtn danger"
                title="Remove the uploaded background"
                onClick={() => onChange({ bgImage: "", bg: display.bg === CUSTOM_BG ? "night" : display.bg })}
              >✕ REMOVE</button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickImage(f);
                e.target.value = ""; // so re-picking the same file fires again
              }}
            />
          </div>
          {display.bgImage && (
            <div className="settings-bgpreview" style={{ backgroundImage: `url("${display.bgImage}")` }} aria-hidden="true" />
          )}

          <label className="pix settings-label" htmlFor="bg-dim">DIM · {display.bgDim}%</label>
          <input
            id="bg-dim"
            className="settings-slider"
            type="range"
            min={0}
            max={90}
            step={5}
            value={display.bgDim}
            onChange={(e) => onChange({ bgDim: Number(e.target.value) })}
          />
          <div className="pix settings-hint">Darkens whatever is behind the panels. Useful for a busy photo.</div>

          <label className="pix settings-label" htmlFor="line-rows">
            THE LINE · STACK · {display.lineRows === LINE_ROWS_OFF ? "NO LIMIT" : `${display.lineRows} CARDS`}
          </label>
          <input
            id="line-rows"
            className="settings-slider"
            type="range"
            /* One step below the minimum is OFF, so "no cap at all" is the far
               left of the same control rather than a separate button. */
            min={LINE_ROWS_MIN - 1}
            max={LINE_ROWS_MAX}
            step={1}
            value={display.lineRows === LINE_ROWS_OFF ? LINE_ROWS_MIN - 1 : display.lineRows}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ lineRows: n < LINE_ROWS_MIN ? LINE_ROWS_OFF : n });
            }}
          />
          <div className="pix settings-hint">
            How many cards a column shows before it scrolls. NO LIMIT lets the column grow with its stack.
          </div>

          <div className="pix settings-label">STATUS BAR</div>
          <div className="settings-row">
            <button className={`deskbtn ${face ? "on" : ""}`} aria-pressed={face} onClick={onToggleFace}>🕶 {face ? "ON" : "OFF"}</button>
          </div>
          <div className="pix settings-hint">A DOOM status bar across the foot of the screen: tokens left, budget health, a slot per agent, board progress, and Agent Smith — who sours as the fleet burns budget and turns to look when an agent needs you.</div>

          <div className="pix settings-label">ALERTS</div>
          <div className="settings-row">
            <button className={`deskbtn ${alertsEnabled ? "on" : ""}`} aria-pressed={alertsEnabled} onClick={onToggleAlerts}>
              🔔 {alertsEnabled ? "ON" : "OFF"}
            </button>
          </div>
          <div className="pix settings-hint">A desktop notification + sound when an agent needs you.</div>
        </div>
      </aside>
    </ModalBackdrop>
  );
}
