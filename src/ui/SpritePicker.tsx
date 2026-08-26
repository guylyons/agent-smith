import { useState } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { PALETTES, GEARS, paletteFor } from "./sprite-data";
import { setSprite } from "./actions";

/** Modal for choosing a custom sprite (palette + gear) for one agent, overriding
 * the deterministic default derived from sessionId+role. */
export function SpritePicker({ agent, onClose }: { agent: AgentStatus; onClose: () => void }) {
  const defaults = paletteFor(agent.sessionId, agent.role);
  const [palette, setPalette] = useState(agent.sprite?.palette ?? 0);
  const [gear, setGear] = useState(agent.sprite?.gear ?? defaults.gear);

  function save() {
    setSprite(agent.sessionId, palette, gear);
    onClose();
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="win spritepicker" onClick={(e) => e.stopPropagation()}>
        <div className="pix spritepicker-title">CHOOSE SPRITE</div>

        <div className="spritepicker-preview">
          <Sprite sessionId={agent.sessionId} role={agent.role} state="working" override={{ palette, gear }} />
        </div>

        <label className="pix spritepicker-label">PALETTE</label>
        <div className="sprite-grid">
          {PALETTES.map((_, i) => (
            <button
              key={i}
              className={`sprite-option ${i === palette ? "selected" : ""}`}
              title={`Palette ${i + 1}`}
              onClick={() => setPalette(i)}
            >
              <Sprite sessionId={agent.sessionId} role={agent.role} state="idle" override={{ palette: i, gear }} />
            </button>
          ))}
        </div>

        <label className="pix spritepicker-label">GEAR</label>
        <div className="sprite-grid">
          {GEARS.map((g) => (
            <button
              key={g}
              className={`sprite-option ${g === gear ? "selected" : ""}`}
              title={g}
              onClick={() => setGear(g)}
            >
              <Sprite sessionId={agent.sessionId} role={agent.role} state="idle" override={{ palette, gear: g }} />
            </button>
          ))}
        </div>

        <div className="newagent-actions">
          <button className="deskbtn" onClick={onClose}>CANCEL</button>
          <button className="deskbtn primary" onClick={save}>SAVE</button>
        </div>
      </div>
    </div>
  );
}
