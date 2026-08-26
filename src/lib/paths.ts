import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function statusDir(): string {
  return process.env.AGENT_STATUS_DIR ?? join(homedir(), ".agent-status");
}

export function ensureStatusDir(): string {
  const dir = statusDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
