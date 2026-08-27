// User-designated positions on THE LINE — the "review" / "merged" columns you
// move a crate into yourself, once you've eyeballed committed-but-unpushed work.
// Stored on disk next to the status files (like .overrides.json) so a designation
// survives restarts AND is readable by any Claude session — that's how an agent
// becomes aware of what you've already reviewed or merged.
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export type LineDesignation = { stage: "review" | "merged"; label: string; sessionId?: string };
// keyed by item key (repo|label), the same stable identity buildSnapshot uses.
export type LineState = Record<string, LineDesignation>;

function file(dir: string): string {
  return join(dir, ".line.json");
}

export function readLineState(dir: string): LineState {
  try {
    const o = JSON.parse(readFileSync(file(dir), "utf8"));
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    // Validate every entry — the file is documented as one any Claude session may
    // write, so a bad stage/label must be dropped here rather than crash the
    // snapshot build (buildSnapshot indexes byStage.get(stage) without a guard).
    const out: LineState = {};
    for (const [key, v] of Object.entries(o as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const d = v as Record<string, unknown>;
      if ((d.stage === "review" || d.stage === "merged") && typeof d.label === "string") {
        out[key] = { stage: d.stage, label: d.label, sessionId: typeof d.sessionId === "string" ? d.sessionId : undefined };
      }
    }
    return out;
  } catch {
    return {}; // missing or corrupt — no designations
  }
}

/** Set (review/merged) or clear (null) the user's designation for one item. */
export function setLineStage(dir: string, key: string, desig: LineDesignation | null): void {
  const all = readLineState(dir);
  if (desig) all[key] = desig;
  else delete all[key];
  const tmp = file(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(all));
  renameSync(tmp, file(dir));
}
