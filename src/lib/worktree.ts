// Prepare the git working area a new agent launches into, so two sessions never
// edit the same working tree. Three shapes, picked by what the launcher names:
// an isolated worktree, a feature branch in the folder itself, or both (a
// worktree checked out on a branch you name). Server-side (spawns git); never
// throws — every path resolves to a { ok, ... } result the caller can surface
// as a toast.
import { join, dirname, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
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
