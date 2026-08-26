import { spriteRects, paletteFor } from "./sprite-data";

export function Sprite({ sessionId, role, state }: { sessionId: string; role: string; state: string }) {
  const { palette, gear } = paletteFor(sessionId, role);
  const rects = spriteRects({ gear, palette });
  return (
    <svg className={`sprite ${state === "working" ? "is-bobbing" : ""}`}
         viewBox="0 0 16 24" shapeRendering="crispEdges" aria-hidden="true">
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}
