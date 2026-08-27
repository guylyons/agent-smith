// Create an isolated git worktree to launch a new agent into, so two sessions
// never edit the same working tree. Server-side (spawns git); never throws —
// every path resolves to a { ok, ... } result the caller can surface as a toast.
import { join, dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { slugify } from "./slug";

export type WorktreeResult = { ok: boolean; path?: string; branch?: string; error?: string };

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Add a worktree at `<repoRoot>/.claude/worktrees/<slug>` on a new branch `<slug>`
 * off the folder's current HEAD, where `<slug>` is `slugify(name)`. `cwd` may be
 * the main checkout or an existing linked worktree — the worktree is always placed
 * under the MAIN repo root (the parent of the common git dir). Returns the launch
 * path on success, or an error (bad name / not a repo / name already taken).
 */
export async function createWorktree(cwd: string, name: string): Promise<WorktreeResult> {
  const branch = slugify(name);
  if (!branch) return { ok: false, error: "worktree name has no usable characters" };

  const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
  if (common.code !== 0) return { ok: false, error: "not a git repository" };
  const repoRoot = dirname(resolve(cwd, common.stdout));

  const path = join(repoRoot, ".claude", "worktrees", branch);
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* git will report a real failure */ }

  const add = await git(repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (add.code !== 0) return { ok: false, error: add.stderr || "git worktree add failed" };
  return { ok: true, path, branch };
}
