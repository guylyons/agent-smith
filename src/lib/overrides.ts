// Per-agent user overrides (a custom name, a chosen look), stored next to the
// status files so a rename survives restarts. Keyed by crew id when the agent
// has one (so the override follows it through a /clear), else by session id.
// Applied when building the snapshot.
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { AgentStatus } from "../schema";

export type Overrides = Record<string, { name?: string; sprite?: { palette: number; gear: string; body?: string } }>;

function file(dir: string): string {
  return join(dir, ".overrides.json");
}

export function readOverrides(dir: string): Overrides {
  try {
    const o = JSON.parse(readFileSync(file(dir), "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Overrides) : {};
  } catch {
    return {}; // missing or corrupt — no overrides
  }
}

// Set (or clear, with a nullish value) one override field for a session, then
// atomically rewrite the file. Removing the last field drops the session entry.
function setField<K extends "name" | "sprite">(dir: string, sessionId: string, key: K, value: Overrides[string][K] | null): void {
  const all = readOverrides(dir);
  if (value) all[sessionId] = { ...all[sessionId], [key]: value };
  else if (all[sessionId]) { delete all[sessionId][key]; if (!Object.keys(all[sessionId]).length) delete all[sessionId]; }
  const tmp = file(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(all));
  renameSync(tmp, file(dir));
}

export function setNameOverride(dir: string, sessionId: string, name: string | null): void {
  const trimmed = (name ?? "").trim();
  setField(dir, sessionId, "name", trimmed || null);
}

export function setSpriteOverride(dir: string, sessionId: string, sprite: { palette: number; gear: string; body?: string } | null): void {
  setField(dir, sessionId, "sprite", sprite);
}

/** Return agents with any custom name/sprite applied. Never mutates the inputs. */
export function applyOverrides(agents: AgentStatus[], overrides: Overrides): AgentStatus[] {
  return agents.map((a) => {
    const o = (a.crew && overrides[a.crew.id]) || overrides[a.sessionId];
    if (!o) return a;
    return { ...a, ...(o.name ? { name: o.name } : {}), ...(o.sprite ? { sprite: o.sprite } : {}) };
  });
}
