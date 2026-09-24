// Landing an agent's work: is there anything committed on this card's branch,
// and can it go into the trunk right now? Server-side (spawns git); never
// throws — every path resolves to a value the UI can render as a dead key, a
// live key, or a tooltip saying why not.
//
// The split here is deliberate: `mergeVerdict` is pure (facts in, verdict out)
// so the rules are unit-tested without a repo, and the git-touching functions
// only gather facts and run the one command.
import { dirname, resolve } from "node:path";
import { runExclusive, pending } from "./merge-queue";
import { mergeBlockers, mergeBlockReason, type Board } from "./board";

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
  /** `branch` has nothing ahead because it already arrived in `base` through a
   *  merge commit — work landed outside the dashboard. Only a real merge is
   *  seen; a fast-forward looks the same as a branch with no commits. */
  landed?: boolean;
};

export type MergeState = MergeFacts & {
  /** there is committed work to land — this is what puts the key on the card */
  committed: boolean;
  /** and nothing is in the way, so the key is live */
  ready: boolean;
  /** why it isn't ready, short enough for a tooltip; "" when it is */
  blocked: string;
  /** a merge is already running (or queued) for this trunk — the key holds
   *  until it drains, so two cards never land on the checkout at once */
  merging: boolean;
  /** cards whose overlapping file claims must merge before this one can —
   *  filled in by the server from the board (see holdForClaims) */
  waitingOn?: string[];
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
  if (f.ahead <= 0) return no(f.landed ? `${f.branch} is already in ${f.base}` : `nothing committed on ${f.branch} yet`);

  // Past here the work exists, so the key shows; what's left is whether it can
  // fire right now.
  const not = (blocked: string) => ({ committed: true, ready: false, blocked });
  if (f.dirty) return not(`${f.branch} has uncommitted changes — commit them first`);
  if (f.rootBranch !== f.base) return not(`your main checkout is on ${f.rootBranch || "a detached HEAD"}, not ${f.base}`);
  if (f.rootDirty) return not(`your ${f.base} checkout has uncommitted changes`);
  return { committed: true, ready: true, blocked: "" };
}

/** The git-level state with the board's merge order laid over it: a card
 *  waiting behind an overlapping, unmerged card (see mergeBlockers) keeps its
 *  key but held, and `blocked` names the card to merge first instead of leaving
 *  a bare disabled key. Pure; `waitingOn` is always filled in. */
export function holdForClaims(state: MergeState, board: Board, cardId: string): MergeState {
  const waitingOn = mergeBlockers(board, cardId).map((c) => c.cardId);
  const why = mergeBlockReason(board, cardId);
  if (!why || !state.committed) return { ...state, waitingOn };
  return { ...state, ready: false, blocked: why, waitingOn };
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
 *  resolves the repo everything hangs off. null when `cwd` isn't a repo. Also
 *  the merge queue's key: every worktree of one repo resolves to the same root,
 *  so they all queue against the one shared checkout. */
export async function repoRoot(cwd: string): Promise<string | null> {
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

/** Did `branch` arrive in `base` through a merge commit? True when some merge
 *  on `base` since the branch tip names that tip as a non-first parent — the
 *  shape `git merge --no-ff` (ours, or one run by hand) leaves. A branch that
 *  was only ever created and never committed to has no such merge. */
async function mergedInto(cwd: string, branch: string, base: string): Promise<boolean> {
  const tip = await git(cwd, ["rev-parse", branch]);
  if (tip.code !== 0 || !tip.stdout) return false;
  const merges = await git(cwd, ["rev-list", "--merges", "--parents", `${branch}..${base}`]);
  if (merges.code !== 0) return false;
  return merges.stdout.split("\n").some((line) => line.split(" ").slice(2).includes(tip.stdout));
}

const NOT_A_REPO: MergeState = {
  repo: false, branch: "", base: "", ahead: 0, dirty: false, rootBranch: "", rootDirty: false,
  committed: false, ready: false, blocked: "not a git repository", merging: false,
};

/** Gather the facts a merge decision hangs on, from a worktree and its root.
 *  Pure of any verdict — the rules (mergeVerdict) and the queue (merging) are
 *  applied on top by the callers. */
async function factsFor(cwd: string, root: string): Promise<MergeFacts> {
  const [branch, base, dirty, rootBranch, rootDirty] = await Promise.all([
    currentBranch(cwd), pickBase(root), isDirty(cwd, true), currentBranch(root), isDirty(root, false),
  ]);

  let ahead = 0;
  let landed = false;
  if (branch && base && branch !== base) {
    const count = await git(cwd, ["rev-list", "--count", `${base}..${branch}`]);
    ahead = count.code === 0 ? Number.parseInt(count.stdout, 10) || 0 : 0;
    if (ahead === 0) landed = await mergedInto(cwd, branch, base);
  }

  return { repo: true, branch, base, ahead, dirty, rootBranch, rootDirty, landed };
}

/** Everything the card needs to know about landing this work. Best-effort: a
 *  non-git directory (or no git at all) reads as "nothing to merge". */
export async function readMergeState(cwd: string): Promise<MergeState> {
  if (!cwd) return NOT_A_REPO;
  const root = await repoRoot(cwd);
  if (!root) return NOT_A_REPO;

  const facts = await factsFor(cwd, root);
  const verdict = mergeVerdict(facts);
  const merging = pending(root) > 0;

  // A merge already running on this trunk holds the key: don't offer to land
  // work onto a checkout mid-merge — wait for it to drain, then re-arm.
  if (merging && verdict.committed) {
    return { ...facts, ...verdict, ready: false, blocked: "a merge is in progress — try again in a moment", merging };
  }
  return { ...facts, ...verdict, merging };
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
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, error: "not a git repository" };

  // Take our turn in the queue for this trunk. Everything that touches the
  // shared checkout happens inside here, so two cards can never be mid-merge on
  // it at once.
  return runExclusive(root, async () => {
    // Re-check with the pure rules now that it's our turn — NOT readMergeState,
    // which would count our own queue slot as "a merge in progress" and refuse.
    // The facts are current, so whatever landed ahead of us is already seen.
    const facts = await factsFor(cwd, root);
    const verdict = mergeVerdict(facts);
    if (!verdict.ready) return { ok: false, error: verdict.blocked || "nothing to merge" };

    const merge = await git(root, ["merge", "--no-ff", "--no-edit", facts.branch]);
    if (merge.code !== 0) {
      await git(root, ["merge", "--abort"]);
      const why = (merge.stdout || merge.stderr).split("\n").find((l) => l.trim()) ?? "";
      return { ok: false, error: `could not merge ${facts.branch} into ${facts.base} — ${why || "merge it by hand"}` };
    }
    return { ok: true, branch: facts.branch, base: facts.base };
  });
}
