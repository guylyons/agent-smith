import { memo, useMemo } from "react";
import { spriteRects, paletteFor } from "./sprite-data";

// The pixel grid depends only on sessionId+role, and building it is the priciest
// bit of a card render — memoize the rects, and memo the component so it doesn't
// re-render on every SSE snapshot unless its props actually change.
function SpriteImpl({ sessionId, role, state }: { sessionId: string; role: string; state: string }) {
  const rects = useMemo(() => {
    const { palette, gear } = paletteFor(sessionId, role);
    return spriteRects({ gear, palette });
  }, [sessionId, role]);
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
