import { memo, useMemo } from "react";
import { spriteRects, paletteFor, PALETTES } from "./sprite-data";

// The pixel grid depends only on sessionId+role (or an explicit override), and
// building it is the priciest bit of a card render — memoize the rects, and
// memo the component so it doesn't re-render on every SSE snapshot unless its
// props actually change.
function SpriteImpl({ sessionId, role, state, override }: {
  sessionId: string; role: string; state: string;
  override?: { palette: number; gear: string; body?: string };
}) {
  const rects = useMemo(() => {
    if (override) {
      const palette = PALETTES[override.palette % PALETTES.length];
      return spriteRects({ body: override.body, gear: override.gear, palette });
    }
    const { palette, gear, body } = paletteFor(sessionId, role);
    return spriteRects({ body, gear, palette });
  }, [sessionId, role, override]);
  return (
    <svg className={`sprite ${state === "working" ? "is-bobbing" : ""}`}
         viewBox="0 0 16 24" shapeRendering="crispEdges" aria-hidden="true">
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}

export const Sprite = memo(SpriteImpl);
