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
    return o && typeof o === "object" ? (o as LineState) : {};
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
