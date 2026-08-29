// Landing an agent's work: is there anything committed on this card's branch,
// and can it go into the trunk right now? Server-side (spawns git); never
// throws — every path resolves to a value the UI can render as a dead key, a
// live key, or a tooltip saying why not.
//
// The split here is deliberate: `mergeVerdict` is pure (facts in, verdict out)
// so the rules are unit-tested without a repo, and the git-touching functions
// only gather facts and run the one command.
import { dirname, resolve } from "node:path";

/** The trunk we merge into, first one that exists. */
const BASES = ["main", "master"] as const;

export type MergeFacts = {
  /** false when `cwd` isn't a git repository at all */
  repo: boolean;
  /** the branch the card's work sits on ("" when detached) */
  branch: string;
  /** the trunk it would land in ("" when the repo has neither main nor master) */
  base: string;
  /** commits on `branch` that `base` doesn't have */
  ahead: number;
  /** uncommitted changes in the agent's working tree */
  dirty: boolean;
  /** the branch the MAIN checkout is sitting on — where the merge would run */
  rootBranch: string;
  /** uncommitted changes in that main checkout */
  rootDirty: boolean;
};

export type MergeState = MergeFacts & {
  /** there is committed work to land — this is what puts the key on the card */
  committed: boolean;
  /** and nothing is in the way, so the key is live */
  ready: boolean;
  /** why it isn't ready, short enough for a tooltip; "" when it is */
  blocked: string;
};

/**
 * The rules, pure. `committed` decides whether the MERGE key exists at all —
 * work has to be committed somewhere other than the trunk before landing it is
 * even a question. `ready` decides whether that key does anything: a dirty
 * tree, or a main checkout that's busy, means "not yet" rather than "never",
 * and `blocked` says which.
 */
export function mergeVerdict(f: MergeFacts): { committed: boolean; ready: boolean; blocked: string } {
  const no = (blocked: string) => ({ committed: false, ready: false, blocked });
  if (!f.repo) return no("not a git repository");
  if (!f.branch) return no("this work tree is on a detached HEAD");
  if (!f.base) return no("no main branch to merge into");
  if (f.branch === f.base) return no(`already on ${f.base} — nothing to merge`);
  if (f.ahead <= 0) return no(`nothing committed on ${f.branch} yet`);

  // Past here the work exists, so the key shows; what's left is whether it can
  // fire right now.
  const not = (blocked: string) => ({ committed: true, ready: false, blocked });
  if (f.dirty) return not(`${f.branch} has uncommitted changes — commit them first`);
  if (f.rootBranch !== f.base) return not(`your main checkout is on ${f.rootBranch || "a detached HEAD"}, not ${f.base}`);
  if (f.rootDirty) return not(`your ${f.base} checkout has uncommitted changes`);
  return { committed: true, ready: true, blocked: "" };
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { code: 1, stdout: "", stderr: String(e) };
  }
}

/** The MAIN checkout's root, so a call from inside a linked worktree still
 *  resolves the repo everything hangs off. null when `cwd` isn't a repo. */
async function repoRoot(cwd: string): Promise<string | null> {
  const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
  if (common.code !== 0) return null;
  return dirname(resolve(cwd, common.stdout));
}

async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ["branch", "--show-current"])).stdout;
}

/** Uncommitted work in `cwd`. `untracked` is the difference between the two
 *  questions we ask: "did the agent commit everything it made?" counts new
 *  files, while "can git merge here?" must not — an untracked file (a scratch
 *  dir, another agent's worktree) never blocks a merge. */
async function isDirty(cwd: string, untracked: boolean): Promise<boolean> {
  const st = await git(cwd, ["status", "--porcelain", untracked ? "--untracked-files=normal" : "--untracked-files=no"]);
  return st.code === 0 && st.stdout !== "";
}

async function pickBase(root: string): Promise<string> {
  for (const b of BASES) {
    if ((await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).code === 0) return b;
  }
  return "";
}

const NOT_A_REPO: MergeState = {
  repo: false, branch: "", base: "", ahead: 0, dirty: false, rootBranch: "", rootDirty: false,
  committed: false, ready: false, blocked: "not a git repository",
};

/** Everything the card needs to know about landing this work. Best-effort: a
 *  non-git directory (or no git at all) reads as "nothing to merge". */
export async function readMergeState(cwd: string): Promise<MergeState> {
  if (!cwd) return NOT_A_REPO;
  const root = await repoRoot(cwd);
  if (!root) return NOT_A_REPO;

  const [branch, base, dirty, rootBranch, rootDirty] = await Promise.all([
    currentBranch(cwd), pickBase(root), isDirty(cwd, true), currentBranch(root), isDirty(root, false),
  ]);

  let ahead = 0;
  if (branch && base && branch !== base) {
    const count = await git(cwd, ["rev-list", "--count", `${base}..${branch}`]);
    ahead = count.code === 0 ? Number.parseInt(count.stdout, 10) || 0 : 0;
  }

  const facts: MergeFacts = { repo: true, branch, base, ahead, dirty, rootBranch, rootDirty };
  return { ...facts, ...mergeVerdict(facts) };
}

export type MergeResult = { ok: boolean; branch?: string; base?: string; error?: string };

/**
 * Land the branch `cwd` is on into the trunk, in the MAIN checkout — a real
 * `git merge --no-ff`, so the history says an agent's branch arrived. Refuses
 * anything `readMergeState` says isn't ready rather than half-doing it, and a
 * conflicted merge is aborted so the user's checkout is never left mid-merge
 * by a button press.
 */
export async function mergeWork(cwd: string): Promise<MergeResult> {
  const state = await readMergeState(cwd);
  if (!state.ready) return { ok: false, error: state.blocked || "nothing to merge" };
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, error: "not a git repository" };

  const merge = await git(root, ["merge", "--no-ff", "--no-edit", state.branch]);
  if (merge.code !== 0) {
    await git(root, ["merge", "--abort"]);
    const why = (merge.stdout || merge.stderr).split("\n").find((l) => l.trim()) ?? "";
    return { ok: false, error: `could not merge ${state.branch} into ${state.base} — ${why || "merge it by hand"}` };
  }
  return { ok: true, branch: state.branch, base: state.base };
}
