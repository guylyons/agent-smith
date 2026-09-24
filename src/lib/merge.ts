// Landing an agent's work: is there anything committed on this card's branch,
// and can it go into the trunk right now? Server-side (spawns git); never
// throws — every path resolves to a value the UI can render as a dead key, a
// live key, or a tooltip saying why not.
//
// The split here is deliberate: `mergeVerdict` is pure (facts in, verdict out)
// so the rules are unit-tested without a repo, and the git-touching functions
// only gather facts and run the one command.
import { dirname, join, resolve } from "node:path";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { runExclusive, pending } from "./merge-queue";
import { mergeBlockers, mergeBlockReason, type Board } from "./board";
import { buildPreview, MAX_COMMITS, type MergePreview } from "./mergePreview";
import { isOwnedWorktree } from "./worktree";

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
  /** the full SHA `branch` points at ("" when there is no branch). An amend or
   *  rebase can keep `ahead` the same; this is what says the work changed. */
  tip: string;
  /** uncommitted changes in the agent's working tree */
  dirty: boolean;
  /** the branch the MAIN checkout is sitting on — where the merge would run */
  rootBranch: string;
  /** uncommitted changes in that main checkout */
  rootDirty: boolean;
  /** `base` is checked out in some worktree. When it isn't and the main
   *  checkout is detached (jj keeps git's HEAD that way), the merge is made
   *  without a checkout at all — see mergeDetached. */
  baseCheckedOut: boolean;
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
  // Nothing has the trunk checked out and the main checkout is detached: the
  // merge never touches a working tree, so neither can be in its way.
  if (!f.rootBranch && !f.baseCheckedOut) return { committed: true, ready: true, blocked: "" };
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
 *  dir, another agent's worktree) never blocks a merge. The launcher's own
 *  .claude/settings.local.json never counts: the repo may not ignore it, and
 *  it isn't the agent's work. */
async function isDirty(cwd: string, untracked: boolean): Promise<boolean> {
  const st = await git(cwd, [
    "status", "--porcelain", untracked ? "--untracked-files=normal" : "--untracked-files=no",
    "--", ":/", ":(top,exclude).claude/settings.local.json",
  ]);
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

/** The full SHA `ref` names, or "" when it names nothing. */
async function revParse(cwd: string, ref: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout : "";
}

/** Is `refs/heads/<base>` the checked-out branch of any worktree? */
async function checkedOutAnywhere(root: string, base: string): Promise<boolean> {
  if (!base) return false;
  const list = await git(root, ["worktree", "list", "--porcelain"]);
  return list.stdout.split("\n").includes(`branch refs/heads/${base}`);
}

const NOT_A_REPO: MergeState = {
  repo: false, branch: "", base: "", ahead: 0, tip: "", dirty: false, rootBranch: "", rootDirty: false, baseCheckedOut: false,
  committed: false, ready: false, blocked: "not a git repository", merging: false,
};

/** Gather the facts a merge decision hangs on, from a worktree and its root.
 *  Pure of any verdict — the rules (mergeVerdict) and the queue (merging) are
 *  applied on top by the callers. */
async function factsFor(cwd: string, root: string): Promise<MergeFacts> {
  const [branch, base, dirty, rootBranch, rootDirty] = await Promise.all([
    currentBranch(cwd), pickBase(root), isDirty(cwd, true), currentBranch(root), isDirty(root, false),
  ]);

  const baseCheckedOut = await checkedOutAnywhere(root, base);
  let ahead = 0;
  let landed = false;
  const tip = branch ? await revParse(cwd, branch) : "";
  if (branch && base && branch !== base) {
    const count = await git(cwd, ["rev-list", "--count", `${base}..${branch}`]);
    ahead = count.code === 0 ? Number.parseInt(count.stdout, 10) || 0 : 0;
    if (ahead === 0) landed = await mergedInto(cwd, branch, base);
  }

  return { repo: true, branch, base, ahead, tip, dirty, rootBranch, rootDirty, baseCheckedOut, landed };
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

/**
 * What a merge would land, for the card to show above its MERGE key: the
 * commits on the branch that the trunk lacks (`base..branch`, as `git log`
 * lists them) and the files they change against the merge base
 * (`base...branch`, as `git diff --stat` counts them). Read-only. A branch
 * with nothing to land reads as an empty preview; a git failure as `error`,
 * one line, for the card to say instead of the list. Everything is read at
 * one tip SHA, which the preview carries: that is what the human saw, and
 * what a merge of it must still find (see mergeWork's `tip`).
 */
export async function readMergePreview(cwd: string): Promise<MergePreview | { error: string }> {
  if (!cwd) return { error: "no working directory for this card" };
  const root = await repoRoot(cwd);
  if (!root) return { error: "not a git repository" };
  const [branch, base] = await Promise.all([currentBranch(cwd), pickBase(root)]);
  const tip = branch ? await revParse(cwd, branch) : "";
  const empty = buildPreview({ branch, base, tip, log: "", totalCommits: 0, numstat: "" });
  if (!branch || !base || branch === base || !tip) return empty;

  const [count, log, stat] = await Promise.all([
    git(cwd, ["rev-list", "--count", `${base}..${tip}`]),
    git(cwd, ["log", `--max-count=${MAX_COMMITS}`, "--format=%h%x09%s", `${base}..${tip}`]),
    git(cwd, ["diff", "--numstat", "--no-color", `${base}...${tip}`]),
  ]);
  const failed = [count, log, stat].find((r) => r.code !== 0);
  if (failed) {
    const why = failed.stderr.split("\n").find((l) => l.trim()) ?? "";
    return { error: `git could not read ${branch}: ${why || "unknown error"}` };
  }
  return buildPreview({ branch, base, tip, log: log.stdout, totalCommits: Number.parseInt(count.stdout, 10) || 0, numstat: stat.stdout });
}

/** `commit` is the merge commit made, so what comes after (the UI rebuild)
 *  knows exactly what landed. */
export type MergeResult = { ok: boolean; branch?: string; base?: string; commit?: string; error?: string };

/** The refusal for a merge of a tip that is no longer the branch's. */
export const BRANCH_MOVED = "the branch moved since you looked; review again";

/**
 * Land the branch `cwd` is on into the trunk, in the MAIN checkout — a real
 * `git merge --no-ff`, so the history says an agent's branch arrived. Refuses
 * anything `readMergeState` says isn't ready rather than half-doing it, and a
 * conflicted merge is aborted so the user's checkout is never left mid-merge
 * by a button press.
 *
 * `tip` is the branch tip SHA the human reviewed. When given, a branch that
 * points anywhere else now (a new commit, an amend, a rebase) is refused, and
 * what lands is that SHA — not whatever the branch name reaches a moment later.
 */
export async function mergeWork(cwd: string, opts: { tip?: string } = {}): Promise<MergeResult> {
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
    if (opts.tip && facts.tip !== opts.tip) return { ok: false, error: BRANCH_MOVED };
    const verdict = mergeVerdict(facts);
    if (!verdict.ready) return { ok: false, error: verdict.blocked || "nothing to merge" };

    if (!facts.rootBranch && !facts.baseCheckedOut) return mergeDetached(root, facts.branch, facts.base, facts.tip);

    // Merge the SHA just checked, named as the branch, so a commit landing on
    // the branch between that check and this line can't ride along.
    const merge = await git(root, ["merge", "--no-ff", "-m", `Merge branch '${facts.branch}'`, facts.tip]);
    if (merge.code !== 0) {
      await git(root, ["merge", "--abort"]);
      const why = (merge.stdout || merge.stderr).split("\n").find((l) => l.trim()) ?? "";
      return { ok: false, error: `could not merge ${facts.branch} into ${facts.base} — ${why || "merge it by hand"}` };
    }
    return { ok: true, branch: facts.branch, base: facts.base, commit: await revParse(root, "HEAD") };
  });
}

/** The same --no-ff merge commit, made with plumbing and no working tree:
 *  for a repo whose main checkout is detached and has no worktree on the
 *  trunk. jj keeps a colocated repo like that, and picks up the moved trunk
 *  on its next command. The ref only moves if it is still where we read it. */
async function mergeDetached(root: string, branch: string, base: string, tip: string): Promise<MergeResult> {
  const refused = (why: string): MergeResult => ({ ok: false, error: `could not merge ${branch} into ${base} — ${why || "merge it by hand"}` });
  const [baseTip, branchTip] = await Promise.all([git(root, ["rev-parse", base]), git(root, ["rev-parse", tip])]);
  if (baseTip.code !== 0 || branchTip.code !== 0) return refused(baseTip.stderr || branchTip.stderr);

  // Exit 1 is a conflict; the output then names the conflicted paths.
  const tree = await git(root, ["merge-tree", "--write-tree", "--name-only", baseTip.stdout, branchTip.stdout]);
  if (tree.code !== 0) {
    const lines = tree.stdout.split("\n").slice(1).filter((l) => l.trim());
    return refused(lines.length ? `conflict in ${lines[0]}` : tree.stderr);
  }
  const commit = await git(root, [
    "commit-tree", tree.stdout.split("\n")[0]!, "-p", baseTip.stdout, "-p", branchTip.stdout, "-m", `Merge branch '${branch}'`,
  ]);
  if (commit.code !== 0) return refused(commit.stderr);
  const moved = await git(root, ["update-ref", "-m", `merge ${branch}`, `refs/heads/${base}`, commit.stdout, baseTip.stdout]);
  if (moved.code !== 0) return refused(moved.stderr);
  return { ok: true, branch, base, commit: commit.stdout };
}

export type CleanupResult = {
  /** the worktree directory is gone */
  removed: boolean;
  /** and so is its branch */
  branchDeleted?: boolean;
  /** why something was kept, for the card. Absent when the directory was never
   *  ours to remove (the main checkout, a folder the user picked). */
  why?: string;
};

function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** The launcher wrote .claude/settings.local.json into the worktree; where the
 *  repo doesn't ignore it, `git worktree remove` (no --force) refuses to go.
 *  Delete it just before removal, and only while git sees it as untracked: a
 *  repo that tracks the file keeps its copy. */
async function dropLauncherSettings(wt: string): Promise<void> {
  const st = await git(wt, ["status", "--porcelain", "--untracked-files=all", "--", ":(top).claude/settings.local.json"]);
  if (st.code !== 0 || st.stdout !== "?? .claude/settings.local.json") return;
  try { rmSync(join(wt, ".claude", "settings.local.json")); } catch { /* git will say why it stays */ }
}

/**
 * After `branch` has landed, remove the worktree the dashboard made for it
 * (`<repo>/.claude/worktrees/<name>`) and delete the branch. Only a clean tree
 * whose branch is in the trunk goes, and only with the safe forms: `git
 * worktree remove` (no --force) and `git branch -d` (never -D). Anything else
 * is kept with a `why`. Never throws; the merge stands whatever happens here.
 */
export async function cleanupMergedWork(cwd: string, branch: string): Promise<CleanupResult> {
  if (!cwd || !existsSync(cwd)) return { removed: false };
  const root = await repoRoot(cwd);
  if (!root) return { removed: false };
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const here = real(cwd);
  // The main checkout, a subfolder, or a worktree someone put elsewhere: not ours.
  if (top.code !== 0 || real(top.stdout) !== here) return { removed: false };
  if (dirname(here) !== join(real(root), ".claude", "worktrees")) return { removed: false };
  // Claude Code's own worktrees share that folder; only ours are ours to remove.
  if (!(await isOwnedWorktree(cwd))) return { removed: false };

  return runExclusive(root, async () => {
    const kept = (why: string): CleanupResult => ({ removed: false, why });
    const [on, base, dirty] = await Promise.all([currentBranch(cwd), pickBase(root), isDirty(cwd, true)]);
    if (on !== branch) return kept(`worktree kept: it is on ${on || "a detached HEAD"}, not ${branch}`);
    if (dirty) return kept(`worktree kept: ${here} has uncommitted changes`);
    if (!base || (await git(root, ["merge-base", "--is-ancestor", branch, base])).code !== 0) {
      return kept(`worktree kept: ${branch} is not merged into ${base || "a main branch"}`);
    }
    await dropLauncherSettings(here);
    const rm = await git(root, ["worktree", "remove", here]);
    if (rm.code !== 0) return kept(`worktree kept: ${rm.stderr || "git worktree remove failed"}`);
    const del = await git(root, ["branch", "-d", branch]);
    if (del.code !== 0) return { removed: true, branchDeleted: false, why: `branch ${branch} kept: ${del.stderr || "git branch -d failed"}` };
    return { removed: true, branchDeleted: true };
  });
}

// The CONFIG sweep. Work merged by hand (git merge in a terminal) never goes
// through MERGE, so its worktree and branch are never cleaned up. The sweep
// finds every worktree under `<repo>/.claude/worktrees` that is safe to remove
// and removes those through cleanupMergedWork — the same safe forms, the same
// re-check under the repo's lock.

export type WorktreeFacts = {
  /** the branch checked out there ("" when detached) */
  branch: string;
  /** the trunk ("" when the repo has neither main nor master) */
  base: string;
  /** uncommitted changes, untracked files included */
  dirty: boolean;
  /** `branch` is an ancestor of `base` */
  merged: boolean;
  /** a live agent's cwd is this worktree or inside it */
  live: boolean;
  /** `git worktree lock`ed */
  locked: boolean;
};

/** Why a worktree must stay, or "" when it can go. Pure. A live agent comes
 *  first: a fresh worktree sits at the trunk's tip and so reads as merged, and
 *  the agent in it is the reason that matters. */
export function worktreeKeepReason(f: WorktreeFacts): string {
  if (f.live) return "an agent is working in it";
  if (f.locked) return "it is locked (git worktree lock)";
  if (!f.branch) return "it is on a detached HEAD";
  if (f.dirty) return "it has uncommitted changes";
  if (!f.base) return "the repo has no main branch";
  if (!f.merged) return `${f.branch} is not merged into ${f.base}`;
  return "";
}

export type SweepEntry = { repo: string; path: string; branch: string };
export type CleanupPlan = { remove: SweepEntry[]; keep: (SweepEntry & { why: string })[] };
export type SweepResult = {
  removed: (SweepEntry & { branchDeleted: boolean; why?: string })[];
  kept: (SweepEntry & { why: string })[];
};

type Listed = { path: string; branch: string; locked: boolean; prunable: boolean };

/** `git worktree list --porcelain`, one entry per worktree. */
async function listWorktrees(root: string): Promise<Listed[]> {
  const r = await git(root, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [];
  const out: Listed[] = [];
  for (const block of r.stdout.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length) ?? "";
    out.push({
      path,
      branch: ref.replace(/^refs\/heads\//, ""),
      locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
      prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable ")),
    });
  }
  return out;
}

/** Each distinct repo root behind `dirs`; anything that isn't a repo is dropped. */
async function distinctRoots(dirs: string[]): Promise<string[]> {
  const roots = new Map<string, string>();
  for (const d of dirs) {
    if (!d || !existsSync(d)) continue;
    const root = await repoRoot(d);
    if (root && !roots.has(real(root))) roots.set(real(root), root);
  }
  return [...roots.values()];
}

/**
 * Every worktree under `<repo>/.claude/worktrees` of each repo behind `repos`,
 * split into the ones that can go and the ones that stay (with why). The main
 * checkout and worktrees kept anywhere else are never listed. `liveCwds` are
 * the working directories of the agents still running. Read-only.
 */
export async function planWorktreeCleanup(repos: string[], liveCwds: string[]): Promise<CleanupPlan> {
  const live = liveCwds.filter(Boolean).map(real);
  const plan: CleanupPlan = { remove: [], keep: [] };
  for (const repo of await distinctRoots(repos)) {
    const home = join(real(repo), ".claude", "worktrees");
    const base = await pickBase(repo);
    for (const w of await listWorktrees(repo)) {
      const here = real(w.path);
      if (dirname(here) !== home) continue;
      // Not made by the dashboard (claude --worktree, a subagent's): never listed.
      if (existsSync(w.path) && !(await isOwnedWorktree(w.path))) continue;
      const entry = { repo, path: w.path, branch: w.branch };
      // Its folder is gone: git lists it until a prune, but there is nothing here to remove.
      if (w.prunable || !existsSync(w.path)) {
        plan.keep.push({ ...entry, why: "its folder is missing (git worktree prune clears it)" });
        continue;
      }
      const [dirty, merged] = await Promise.all([
        isDirty(w.path, true),
        w.branch && base ? git(repo, ["merge-base", "--is-ancestor", w.branch, base]).then((r) => r.code === 0) : false,
      ]);
      const why = worktreeKeepReason({
        branch: w.branch, base, dirty, merged, locked: w.locked,
        live: live.some((c) => c === here || c.startsWith(here + "/")),
      });
      if (why) plan.keep.push({ ...entry, why });
      else plan.remove.push(entry);
    }
  }
  return plan;
}

/**
 * Remove what `planWorktreeCleanup` says can go — re-planned now, so nothing
 * that changed since a preview is taken on trust. With `only`, just those
 * paths (what the human confirmed); anything confirmed that no longer
 * qualifies is kept, with why. Every worktree that stays is reported, so the
 * panel can say why. Each removal is cleanupMergedWork's: no --force, `git
 * branch -d`, re-checked under the repo's lock. Never throws.
 */
export async function cleanupMergedWorktrees(repos: string[], liveCwds: string[], only?: string[]): Promise<SweepResult> {
  const plan = await planWorktreeCleanup(repos, liveCwds);
  const wanted = only ? new Set(only.map(real)) : null;
  const res: SweepResult = { removed: [], kept: [...plan.keep] };
  for (const w of wanted ? plan.remove.filter((w) => wanted.has(real(w.path))) : plan.remove) {
    const r = await cleanupMergedWork(w.path, w.branch);
    if (r.removed) res.removed.push({ ...w, branchDeleted: !!r.branchDeleted, ...(r.why ? { why: r.why } : {}) });
    else res.kept.push({ ...w, why: r.why ?? "git would not remove it" });
  }
  return res;
}
