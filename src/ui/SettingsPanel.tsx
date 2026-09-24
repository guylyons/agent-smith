import { useRef, useState } from "react";
import { ModalBackdrop } from "./Backdrop";
import {
  THEMES, FONTS, CRT_MODES, BEVEL_MODES, BACKGROUNDS, CUSTOM_BG,
  LINE_ROWS_MIN, LINE_ROWS_MAX, LINE_ROWS_OFF,
  type BevelMode, type CrtMode, type Display,
} from "./settings";
import { uploadImage, previewWorktreeCleanup, runWorktreeCleanup } from "./actions";
import type { CleanupPlan, SweepEntry, SweepResult } from "../lib/merge";
import { toast } from "./toast";

// How far a freshly uploaded wallpaper is dimmed, so the UI is readable over it
// from the first frame. The user can take it straight back to 0.
const DEFAULT_CUSTOM_DIM = 35;

/** One worktree in the sweep's lists: repo · branch, and why when there is one. */
export function sweepLine(w: SweepEntry & { why?: string; branchDeleted?: boolean }): string {
  const last = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
  const name = `${last(w.repo)} · ${w.branch || last(w.path)}`;
  return w.why ? `${name} — ${w.why}` : name;
}

export function sweepConfirmLabel(n: number): string {
  return `REMOVE ${n} WORKTREE${n === 1 ? "" : "S"}`;
}

export type Sweep =
  | { step: "idle" }
  | { step: "busy"; doing: "checking" | "removing" }
  | { step: "confirm"; plan: CleanupPlan }
  | { step: "done"; result: SweepResult }
  | { step: "error"; error: string };

/** The sweep's one main button: the same element in every step, so focus
 *  stays on it while it looks, confirms and removes. `busy` greys it without
 *  `disabled`, which would drop focus to the page. */
export function sweepButton(sweep: Sweep): { label: string; danger: boolean; busy: boolean } {
  if (sweep.step === "busy") return { label: sweep.doing === "removing" ? "REMOVING…" : "CHECKING…", danger: sweep.doing === "removing", busy: true };
  if (sweep.step === "confirm" && sweep.plan.remove.length > 0) return { label: sweepConfirmLabel(sweep.plan.remove.length), danger: true, busy: false };
  return { label: "🧹 CLEAN UP MERGED WORKTREES", danger: false, busy: false };
}

/** What the live region says for each step, so a screen reader hears the
 *  sweep's progress and outcome without hunting for it. */
export function sweepStatus(sweep: Sweep): string {
  const n = (k: number) => `${k} worktree${k === 1 ? "" : "s"}`;
  switch (sweep.step) {
    case "idle": return "";
    case "busy": return sweep.doing === "removing" ? "Removing worktrees…" : "Checking worktrees…";
    case "error": return sweep.error;
    case "confirm": return sweep.plan.remove.length
      ? `${n(sweep.plan.remove.length)} can go, ${sweep.plan.keep.length} stay.`
      : "Nothing to clean up.";
    case "done": return `Removed ${n(sweep.result.removed.length)}, kept ${sweep.result.kept.length}.`;
  }
}

function SweepList({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <>
      <div className="pix settings-hint">{title}</div>
      <ul className="settings-sweep">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </>
  );
}

// Worktrees merged by hand never went through MERGE, so nothing removed them.
// Look first, then one confirm; the server re-checks each one as it goes.
function WorktreeSweep() {
  const [sweep, setSweep] = useState<Sweep>({ step: "idle" });
  const mainRef = useRef<HTMLButtonElement>(null);
  async function look() {
    setSweep({ step: "busy", doing: "checking" });
    const r = await previewWorktreeCleanup();
    setSweep("error" in r ? { step: "error", error: r.error } : { step: "confirm", plan: r });
  }
  async function remove(plan: CleanupPlan) {
    setSweep({ step: "busy", doing: "removing" });
    const r = await runWorktreeCleanup(plan.remove.map((w) => w.path));
    setSweep("error" in r ? { step: "error", error: r.error } : { step: "done", result: r });
  }
  function press() {
    if (sweep.step === "busy") return;
    if (sweep.step === "confirm" && sweep.plan.remove.length > 0) void remove(sweep.plan);
    else void look();
  }
  const btn = sweepButton(sweep);
  const status = sweepStatus(sweep);
  return (
    <>
      <div className="pix settings-label">WORKTREES</div>
      <div className="settings-row">
        <button ref={mainRef} className={`deskbtn${btn.danger ? " danger" : ""}`} aria-disabled={btn.busy} onClick={press}>
          {btn.label}
        </button>
        {sweep.step === "confirm" && sweep.plan.remove.length > 0 && (
          // CANCEL unmounts itself: hand focus back to the main button first.
          <button className="deskbtn" onClick={() => { mainRef.current?.focus(); setSweep({ step: "idle" }); }}>CANCEL</button>
        )}
      </div>
      <div className="sr-only" role="status">{status}</div>
      {sweep.step === "idle" && (
        <div className="pix settings-hint">
          Lists worktrees under .claude/worktrees that are clean, merged into main and not in use by an agent, then removes them and their branches after you confirm.
        </div>
      )}
      {sweep.step === "error" && <div className="pix settings-hint">{sweep.error}</div>}
      {sweep.step === "confirm" && (
        <>
          <SweepList title={`${sweep.plan.remove.length} CAN GO:`} lines={sweep.plan.remove.map(sweepLine)} />
          {sweep.plan.remove.length === 0 && <div className="pix settings-hint">Nothing to clean up.</div>}
          <SweepList title={`${sweep.plan.keep.length} STAY:`} lines={sweep.plan.keep.map(sweepLine)} />
        </>
      )}
      {sweep.step === "done" && (
        <>
          <SweepList title={`REMOVED ${sweep.result.removed.length}:`} lines={sweep.result.removed.map(sweepLine)} />
          {sweep.result.removed.length === 0 && <div className="pix settings-hint">Nothing was removed.</div>}
          <SweepList title={`KEPT ${sweep.result.kept.length}:`} lines={sweep.result.kept.map(sweepLine)} />
        </>
      )}
    </>
  );
}

// One place for the display/alert controls. The values live in App (the CRT
// overlay needs the mode too), so this panel only renders them and reports a
// patch back — every change applies live, nothing to save.
export function SettingsPanel({ display, onChange, alertsEnabled, onToggleAlerts, face, onToggleFace, fight, onToggleFight, onClose }: {
  display: Display;
  onChange: (patch: Partial<Display>) => void;
  alertsEnabled: boolean;
  onToggleAlerts: () => void;
  face: boolean;
  onToggleFace: () => void;
  fight: boolean;
  onToggleFight: () => void;
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
    <ModalBackdrop onClose={onClose} labelledBy="settings-title">
      <aside className="win settings">
        <div className="settings-head">
          <span id="settings-title" className="pix settings-title">CONFIG</span>
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

          <label className="pix settings-label" htmlFor="ui-font">FONT</label>
          <select
            id="ui-font"
            className="settings-select"
            value={display.font}
            onChange={(e) => onChange({ font: e.target.value })}
          >
            {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <div className="pix settings-hint">The face for the whole app. THEME'S OWN uses the one the theme ships with.</div>

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

          <div className="pix settings-label">THE LINE FIGHT</div>
          <div className="settings-row">
            <button className={`deskbtn ${fight ? "on" : ""}`} aria-pressed={fight} onClick={onToggleFight}>🔥 {fight ? "ON" : "OFF"}</button>
          </div>
          <div className="pix settings-hint">Ripley and her flamethrower against a xenomorph, in a strip of corridor across the top of THE LINE. A new random round each time. Holds still if your system asks for reduced motion.</div>

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

          <WorktreeSweep />
        </div>
      </aside>
    </ModalBackdrop>
  );
}
