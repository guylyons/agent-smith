import { useState } from "react";
import type { AgentStatus } from "../schema";
import { Sprite } from "./Sprite";
import { ModalBackdrop } from "./Backdrop";
import { PALETTES, GEARS, BODIES, BODY_IDS, paletteFor } from "./sprite-data";
import { setSprite } from "./actions";

/** Modal for choosing a custom sprite (character + palette + gear) for one agent,
 * overriding the deterministic default derived from sessionId+role. */
export function SpritePicker({ agent, onClose }: { agent: AgentStatus; onClose: () => void }) {
  const defaults = paletteFor(agent.sessionId, agent.role);
  // Seed from the agent's ACTUAL default palette (the deterministic hash pick),
  // not index 0 — otherwise the preview shows the wrong colors for every agent
  // whose hash palette isn't 0, and SAVE-without-changes recolors it to 0.
  const defaultPaletteIndex = Math.max(0, PALETTES.indexOf(defaults.palette));
  const [palette, setPalette] = useState(agent.sprite?.palette ?? defaultPaletteIndex);
  const [gear, setGear] = useState(agent.sprite?.gear ?? defaults.gear);
  const [body, setBody] = useState(agent.sprite?.body ?? defaults.body);

  const hasGear = BODIES[body]?.gear ?? false;

  function save() {
    setSprite(agent.sessionId, palette, gear, body);
    onClose();
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="win spritepicker">
        <div className="pix spritepicker-title">CHOOSE SPRITE</div>

        <div className="spritepicker-preview">
          <Sprite sessionId={agent.sessionId} role={agent.role} state="working" override={{ palette, gear, body }} />
        </div>

        <label className="pix spritepicker-label">CHARACTER</label>
        <div className="sprite-grid">
          {BODY_IDS.map((b) => (
            <button
              key={b}
              className={`sprite-option ${b === body ? "selected" : ""}`}
              title={BODIES[b].label}
              onClick={() => setBody(b)}
            >
              <Sprite sessionId={agent.sessionId} role={agent.role} state="idle" override={{ palette, gear, body: b }} />
            </button>
          ))}
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
              <Sprite sessionId={agent.sessionId} role={agent.role} state="idle" override={{ palette: i, gear, body }} />
            </button>
          ))}
        </div>

        {hasGear && (
          <>
            <label className="pix spritepicker-label">GEAR</label>
            <div className="sprite-grid">
              {GEARS.map((g) => (
                <button
                  key={g}
                  className={`sprite-option ${g === gear ? "selected" : ""}`}
                  title={g}
                  onClick={() => setGear(g)}
                >
                  <Sprite sessionId={agent.sessionId} role={agent.role} state="idle" override={{ palette, gear: g, body }} />
                </button>
              ))}
            </div>
          </>
        )}

        <div className="newagent-actions">
          <button className="deskbtn" onClick={onClose}>CANCEL</button>
          <button className="deskbtn primary" onClick={save}>SAVE</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
