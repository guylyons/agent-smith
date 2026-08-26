// Per-session user overrides (currently just a custom name), stored next to the
// status files so a rename survives restarts. Applied when building the snapshot.
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { AgentStatus } from "../schema";

export type Overrides = Record<string, { name?: string; sprite?: { palette: number; gear: string } }>;

function file(dir: string): string {
  return join(dir, ".overrides.json");
}

export function readOverrides(dir: string): Overrides {
  try {
    const o = JSON.parse(readFileSync(file(dir), "utf8"));
    return o && typeof o === "object" ? (o as Overrides) : {};
  } catch {
    return {}; // missing or corrupt — no overrides
  }
}

export function setNameOverride(dir: string, sessionId: string, name: string | null): void {
  const all = readOverrides(dir);
  const trimmed = (name ?? "").trim();
  if (trimmed) all[sessionId] = { ...all[sessionId], name: trimmed };
  else if (all[sessionId]) { delete all[sessionId].name; if (!Object.keys(all[sessionId]).length) delete all[sessionId]; }
  const tmp = file(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(all));
  renameSync(tmp, file(dir));
}

export function setSpriteOverride(dir: string, sessionId: string, sprite: { palette: number; gear: string } | null): void {
  const all = readOverrides(dir);
  if (sprite) all[sessionId] = { ...all[sessionId], sprite };
  else if (all[sessionId]) { delete all[sessionId].sprite; if (!Object.keys(all[sessionId]).length) delete all[sessionId]; }
  const tmp = file(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(all));
  renameSync(tmp, file(dir));
}

/** Return agents with any custom name/sprite applied. Never mutates the inputs. */
export function applyOverrides(agents: AgentStatus[], overrides: Overrides): AgentStatus[] {
  return agents.map((a) => {
    const o = overrides[a.sessionId];
    if (!o) return a;
    return { ...a, ...(o.name ? { name: o.name } : {}), ...(o.sprite ? { sprite: o.sprite } : {}) };
  });
}
