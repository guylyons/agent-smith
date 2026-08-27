// A dashboard-launched agent starts `claude` in a freshly created worktree. That
// path has no entry in ~/.claude.json, so Claude Code stops at "Do you trust the
// files in this folder?" before its first turn — and an unattended card never
// runs. A worktree is `git worktree add … HEAD` off a repo, so its tracked files
// are the same code the user already trusted at the repo root. This module lets
// createWorktree extend that existing trust to the derived worktree — and ONLY
// then: if the repo root itself isn't trusted, we touch nothing.
//
// Everything here is best-effort and never throws: failing to register trust
// just leaves the old stall behavior, it must never abort worktree creation.
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

type ProjectEntry = { hasTrustDialogAccepted?: boolean; [k: string]: unknown };
export type ClaudeConfig = { projects?: Record<string, ProjectEntry>; [k: string]: unknown };

/** Where Claude Code keeps per-project trust. Overridable for tests so they never
 *  touch the real file. */
export function configPath(): string {
  return process.env.CLAUDE_CONFIG_PATH ?? join(homedir(), ".claude.json");
}

/** Has the trust dialog been accepted for this exact path? Trust is keyed by the
 *  exact directory, not inherited from an ancestor. */
export function isPathTrusted(config: ClaudeConfig, path: string): boolean {
  return config.projects?.[path]?.hasTrustDialogAccepted === true;
}

/** Return a copy of `config` with `path` marked trusted, creating the projects
 *  map/entry as needed and preserving every other key. Does not mutate `config`. */
export function withTrust(config: ClaudeConfig, path: string): ClaudeConfig {
  const projects = { ...(config.projects ?? {}) };
  projects[path] = { ...(projects[path] ?? {}), hasTrustDialogAccepted: true };
  return { ...config, projects };
}

/** The indent unit to round-trip a JSON file with: the leading whitespace of its
 *  first key (matching Claude Code's 2-space file), or 0 when it's minified. The
 *  return type matches JSON.stringify's third argument. */
export function detectIndent(raw: string): string | number {
  const m = raw.match(/^\{\r?\n([ \t]+)"/);
  return m ? m[1]! : 0;
}

export type TrustResult = { ok: boolean; trusted: boolean; error?: string };

/**
 * Register trust for `worktreePath` — but only if `repoRoot` is already trusted.
 * Reads the config immediately before writing and swaps it in with a temp-file +
 * rename (atomic on one filesystem) to keep the clobber window small. Never
 * throws; returns whether the path ended up trusted.
 *
 * `trusted: false` with `ok: true` means the gate declined (repo root not
 * trusted) — an expected, non-error outcome.
 */
export function registerWorktreeTrust(repoRoot: string, worktreePath: string, file = configPath()): TrustResult {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (e) { return { ok: false, trusted: false, error: `read: ${String(e)}` }; }

  let config: ClaudeConfig;
  try { config = JSON.parse(raw) as ClaudeConfig; } catch (e) { return { ok: false, trusted: false, error: `parse: ${String(e)}` }; }

  // Gate: never trust a worktree whose repo root the user hasn't trusted.
  if (!isPathTrusted(config, repoRoot)) return { ok: true, trusted: false };
  // Already trusted (e.g. a re-created worktree): nothing to write.
  if (isPathTrusted(config, worktreePath)) return { ok: true, trusted: true };

  const out = JSON.stringify(withTrust(config, worktreePath), null, detectIndent(raw)) + (raw.endsWith("\n") ? "\n" : "");
  const tmp = join(dirname(file), `.claude.json.aw-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, out);
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* temp already gone */ }
    return { ok: false, trusted: false, error: `write: ${String(e)}` };
  }
  return { ok: true, trusted: true };
}
