import type { LineStage } from "../lib/snapshot";

const STAGES: { key: LineStage["stage"]; label: string }[] = [
  { key: "backlog", label: "BACKLOG" },
  { key: "working", label: "WORKING" },
  { key: "needs", label: "NEEDS YOU" },
  { key: "review", label: "REVIEW" },
  { key: "merged", label: "MERGED" },
];

// Cosmetic-only ownership colors, matching the mock's crate accents.
const OWNER_COLORS = ["#8fc0ff", "#d8dcf0", "#f2b134", "#4fbf6a", "#b7a8ff"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function ownerColor(ticket: string): string {
  return OWNER_COLORS[hash(ticket) % OWNER_COLORS.length]!;
}

export function TheLine({ line }: { line: LineStage[] }) {
  const byStage = new Map(line.map((l) => [l.stage, l.tickets]));

  return (
    <section className="win line">
      <h2 className="pix">THE LINE</h2>
      <p className="pix hint">WHERE EVERY TICKET IS BEFORE IT LANDS</p>
      <div className="stages">
        {STAGES.map((s) => (
          <div className="stage" data-key={s.key} key={s.key}>
            <div className="pix stage-head">{s.label}</div>
            <div className="slot">
              {(byStage.get(s.key) ?? []).map((t) => (
                <div className="crate" data-num={t} key={t}>
                  <div className="pix num">{t}</div>
                  <div className="own" style={{ background: ownerColor(t) }}></div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="belt">
        <div className="tread"></div>
      </div>
    </section>
  );
}
