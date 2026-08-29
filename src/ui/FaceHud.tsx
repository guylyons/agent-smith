import type { AgentStatus } from "../schema";
import type { Board } from "../lib/board";
import {
  pickFace, faceTitle,
  FACE_COLS, FACE_ROWS, FACE_CELL_W, FACE_CELL_H,
  type FaceState,
} from "../lib/face";
import { hudStats } from "../lib/hud";
import { fleetUsage, fmtTokens } from "../lib/usage";
import facesUrl from "./faces.png";

// Displayed at exactly 2x the native cell, so every source pixel maps to a whole
// 2x2 block and the sprite stays crisp under image-rendering: pixelated.
const SCALE = 2;

/** The reading for a panel with no data behind it. DOOM never shows a blank
 *  slot, and a dash is honestly "unknown" where a 0 would claim empty. */
const NO_DATA = "--";

/** One big-number panel: the reading over its caption, DOOM's own hierarchy. */
function Panel({ value, caption, tone }: { value: string; caption: string; tone?: string }) {
  return (
    <div className={`facehud-panel${tone ? ` ${tone}` : ""}`}>
      <div className="facehud-num">{value}</div>
      <div className="pix facehud-cap">{caption}</div>
    </div>
  );
}

/**
 * The DOOM status bar, read off the live fleet: AMMO, HEALTH, ARMS, Smith,
 * ARMOR and the ammo table, in the order the original puts them.
 *
 * Every number comes from lib/hud.ts and the face from lib/face.ts, both pure —
 * so this component holds no state and runs no timers. It re-renders only when
 * a snapshot actually changes something, and the face is a function of the
 * fleet rather than of the clock.
 */
export function FaceHud({ agents, board }: { agents: AgentStatus[]; board: Board }) {
  const { ammo, health, arms, armor, table } = hudStats(agents, board);
  const usage = fleetUsage(agents);

  const state: FaceState = {
    pct: usage ? usage.pct : null,
    waiting: agents.filter((a) => a.state === "waiting").length,
    working: agents.filter((a) => a.state === "working").length,
    procs: agents.reduce((n, a) => n + (a.subagents ?? 0), 0),
    agents: agents.length,
  };
  const face = pickFace(state);
  const label = faceTitle(state);

  // The same thresholds the header's usage meter uses, so a fleet that reads
  // "amber" in one place can never read "fine" in the other.
  const hpTone = health === null ? "" : health <= 25 ? "hp-low" : health <= 50 ? "hp-warn" : "";

  return (
    <div className="facehud" role="group" aria-label="Fleet status">
     <div className="facehud-inner">
      <Panel value={ammo === null ? NO_DATA : fmtTokens(ammo)} caption="AMMO" />
      <Panel
        value={health === null ? NO_DATA : `${health}%`}
        caption="HEALTH"
        tone={hpTone}
      />

      <div className="facehud-panel facehud-arms">
        <div className="facehud-armsgrid" aria-hidden="true">
          {arms.map((slot, i) => (
            <span key={i} className={`facehud-slot is-${slot}`}>{i + 1}</span>
          ))}
        </div>
        <div className="pix facehud-cap">ARMS</div>
      </div>

      <div
        className="facehud-face"
        role="img"
        aria-label={label}
        title={label}
        style={{
          backgroundImage: `url(${facesUrl})`,
          width: FACE_CELL_W * SCALE,
          height: FACE_CELL_H * SCALE,
          backgroundSize: `${FACE_COLS * FACE_CELL_W * SCALE}px ${FACE_ROWS * FACE_CELL_H * SCALE}px`,
          backgroundPosition: `-${face.col * FACE_CELL_W * SCALE}px -${face.row * FACE_CELL_H * SCALE}px`,
        }}
      />

      <Panel value={`${armor}%`} caption="ARMOR" />

      <div className="facehud-table">
        {table.map((row) => (
          <div className="facehud-row" key={row.label}>
            <span className="pix facehud-rowlabel">{row.label}</span>
            <span className="facehud-rowcount">{row.count}</span>
            <span className="facehud-rowslash">/</span>
            <span className="facehud-rowtotal">{row.total}</span>
          </div>
        ))}
      </div>
     </div>
    </div>
  );
}
