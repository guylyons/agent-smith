// Prepare the git working area a new agent launches into, so two sessions never
// edit the same working tree. Three shapes, picked by what the launcher names:
// an isolated worktree, a feature branch in the folder itself, or both (a
// worktree checked out on a branch you name). Server-side (spawns git); never
// throws — every path resolves to a { ok, ... } result the caller can surface
// as a toast.
import { join, dirname, resolve } from "node:path";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { slugify, slugifyBranch } from "./slug";
import { registerWorktreeTrust } from "./trust";

export type WorktreeResult = {
  ok: boolean;
  /** Where the agent should be launched. */
  path?: string;
  /** The branch it will be sitting on, once prepared. */
  branch?: string;
  /** True only when a brand-new worktree directory was just created — the
   *  caller uses it to decide whether writing settings into that directory is
   *  its business (a fresh worktree: yes; the user's own folder: never). */
  worktreeCreated?: boolean;
  /** For a created worktree: the real (symlink-resolved) path of the main
   *  checkout it hangs off -- where its branch gets merged. */
  repoRoot?: string;
  error?: string;
};

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** The MAIN checkout's root (the parent of the common git dir), so a call made
 *  from inside a linked worktree still resolves to the repo everything hangs
 *  off. null when `cwd` isn't a git repository at all. */
async function repoRoot(cwd: string): Promise<string | null> {
  const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
  if (common.code !== 0) return null;
  return dirname(resolve(cwd, common.stdout));
}

/** The folder a card's repo label names: the main checkout's real path when
 *  `cwd` is in a git repo (so a worktree resolves to the repo it hangs off),
 *  else `cwd` itself. Never throws. */
export async function mainCheckout(cwd: string): Promise<string> {
  const root = (await repoRoot(cwd)) ?? cwd;
  try { return realpathSync(root); } catch { return root; }
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

/**
 * Add a worktree at `<repoRoot>/.claude/worktrees/<slug(name)>`. The branch is
 * `branchName` when given (slugified, `/` kept) and `slug(name)` otherwise —
 * so naming only a worktree behaves exactly as it always has. An existing
 * branch is checked out into the worktree rather than being re-created, which
 * is what "put this worktree on my feature branch" has to mean.
 *
 * `cwd` may be the main checkout or an existing linked worktree — the worktree
 * is always placed under the main repo root. Returns the launch path on
 * success, or an error (bad name / not a repo / name already taken).
 */
export async function createWorktree(cwd: string, name: string, branchName?: string): Promise<WorktreeResult> {
  const dir = slugify(name);
  if (!dir) return { ok: false, error: "worktree name has no usable characters" };
  const branch = branchName === undefined ? dir : slugifyBranch(branchName);
  if (!branch) return { ok: false, error: "branch name has no usable characters" };

  const root = await repoRoot(cwd);
  if (!root) return { ok: false, error: "not a git repository" };

  const path = join(root, ".claude", "worktrees", dir);
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* git will report a real failure */ }

  const add = (await branchExists(root, branch))
    ? await git(root, ["worktree", "add", path, branch])
    : await git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (add.code !== 0) return { ok: false, error: add.stderr || "git worktree add failed" };
  // Without the marker cleanup never removes it: kept, never lost.
  await markWorktreeOwned(path);

  // Extend the repo root's existing trust to this derived worktree so an agent
  // launched here doesn't stall on the trust dialog before its first turn. Gated
  // on the root already being trusted, and best-effort — a failure just leaves
  // the old stall behavior, it never fails the worktree we just made.
  registerWorktreeTrust(root, path);

  let real = root;
  try { real = realpathSync(root); } catch { /* keep the resolved path */ }
  return { ok: true, path, branch, worktreeCreated: true, repoRoot: real };
}

/**
 * Put `cwd` itself on a feature branch — no worktree, no second checkout. For
 * the common case where you want an agent's work on its own branch but in the
 * folder you're already looking at. An existing branch is switched to rather
 * than re-created, and already being on it is a no-op success. The launch path
 * is `cwd` unchanged.
 *
 * Note this MOVES the folder you named: anything else pointed at it (an editor,
 * another terminal) is now on the new branch too. That's the trade you accept
 * by choosing a branch over a worktree.
 */
export async function createBranch(cwd: string, name: string): Promise<WorktreeResult> {
  const branch = slugifyBranch(name);
  if (!branch) return { ok: false, error: "branch name has no usable characters" };

  if (!(await repoRoot(cwd))) return { ok: false, error: "not a git repository" };

  const current = await git(cwd, ["branch", "--show-current"]);
  if (current.code === 0 && current.stdout === branch) return { ok: true, path: cwd, branch };

  const sw = (await branchExists(cwd, branch))
    ? await git(cwd, ["switch", branch])
    : await git(cwd, ["switch", "-c", branch]);
  if (sw.code !== 0) return { ok: false, error: sw.stderr || `could not switch to ${branch}` };

  return { ok: true, path: cwd, branch };
}

/**
 * The one entry point a launcher calls: resolve `{ worktree, branch }` — either,
 * both, or neither — into the directory to start the agent in.
 *
 *   worktree only     isolated worktree, branch named after it (the original)
 *   worktree + branch isolated worktree, checked out on the branch you named
 *   branch only       the folder itself, switched onto that branch
 *   neither           the folder itself, on whatever branch it's already on
 */
export async function prepareLaunch(
  cwd: string,
  opts: { worktree?: string; branch?: string } = {},
): Promise<WorktreeResult> {
  const worktree = opts.worktree?.trim();
  const branch = opts.branch?.trim();
  if (worktree) return createWorktree(cwd, worktree, branch || undefined);
  if (branch) return createBranch(cwd, branch);
  return { ok: true, path: cwd };
}

// Claude Code makes its own worktrees in the same .claude/worktrees folder
// (`claude --worktree`, subagent isolation). Cleanup must tell ours apart, so
// createWorktree drops a marker in the worktree's private git dir
// (.git/worktrees/<name>/): outside the working tree, so it never shows as a
// change, and `git worktree remove` takes it along.
const OWNED_MARKER = "agent-smith-worktree";

/** The private git dir of the linked worktree at `path`; null for the main
 *  checkout (whose git dir is the common one) or a non-repo. */
async function linkedGitDir(path: string): Promise<string | null> {
  const r = await git(path, ["rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"]).catch(() => null);
  if (!r || r.code !== 0) return null;
  const [dir, common, top] = r.stdout.split("\n");
  if (!dir || !common || !top) return null;
  // Only the worktree's own top level counts, never a folder inside it.
  if (realOr(top) !== realOr(path)) return null;
  return realOr(dir) === realOr(resolve(path, common)) ? null : dir;
}

function realOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Record that the dashboard made the worktree at `path`. False when it isn't
 *  a linked worktree or the write failed. Never throws. */
export async function markWorktreeOwned(path: string): Promise<boolean> {
  const dir = await linkedGitDir(path);
  if (!dir) return false;
  try { writeFileSync(join(dir, OWNED_MARKER), "made by the agent-smith dashboard\n"); return true; } catch { return false; }
}

/** Did the dashboard make the worktree at `path`? Never throws. */
export async function isOwnedWorktree(path: string): Promise<boolean> {
  const dir = await linkedGitDir(path);
  return !!dir && existsSync(join(dir, OWNED_MARKER));
}
