import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mergeVerdict, readMergeState, mergeWork, repoRoot, cleanupMergedWork, type MergeFacts } from "../src/lib/merge";
import { runExclusive } from "../src/lib/merge-queue";
import { markWorktreeOwned } from "../src/lib/worktree";

// --- the rules, without a repo ---------------------------------------------

const facts = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  repo: true, branch: "ag-6", base: "main", ahead: 2, tip: "", dirty: false,
  rootBranch: "main", rootDirty: false, baseCheckedOut: true, ...over,
});

test("committed work on a branch, everything clean, is ready to merge", () => {
  expect(mergeVerdict(facts())).toEqual({ committed: true, ready: true, blocked: "" });
});

test("no commits yet means no key at all", () => {
  const v = mergeVerdict(facts({ ahead: 0 }));
  expect(v.committed).toBe(false);
  expect(v.blocked).toBe("nothing committed on ag-6 yet");
});

test("work done straight on the trunk has nothing to merge", () => {
  expect(mergeVerdict(facts({ branch: "main" })).committed).toBe(false);
});

test("a non-repo, a detached HEAD and a trunkless repo all show no key", () => {
  expect(mergeVerdict(facts({ repo: false })).committed).toBe(false);
  expect(mergeVerdict(facts({ branch: "" })).blocked).toMatch(/detached/);
  expect(mergeVerdict(facts({ base: "" })).blocked).toMatch(/no main branch/);
});

test("uncommitted changes on the branch show the key but hold it", () => {
  const v = mergeVerdict(facts({ dirty: true }));
  expect(v).toMatchObject({ committed: true, ready: false });
  expect(v.blocked).toMatch(/uncommitted/);
});

test("a main checkout that is busy holds the key, and says how", () => {
  expect(mergeVerdict(facts({ rootBranch: "other" }))).toMatchObject({ committed: true, ready: false });
  expect(mergeVerdict(facts({ rootBranch: "other" })).blocked).toMatch(/on other, not main/);
  expect(mergeVerdict(facts({ rootDirty: true })).blocked).toMatch(/main checkout has uncommitted/);
});

test("a detached main checkout with the trunk checked out nowhere merges without it", () => {
  // jj keeps git's HEAD detached and its working copy reads as dirty to git.
  expect(mergeVerdict(facts({ rootBranch: "", rootDirty: true, baseCheckedOut: false })))
    .toEqual({ committed: true, ready: true, blocked: "" });
});

test("a detached main checkout still holds the key when the trunk is checked out elsewhere", () => {
  expect(mergeVerdict(facts({ rootBranch: "", baseCheckedOut: true })).blocked).toMatch(/detached HEAD, not main/);
});

// --- against throwaway repos ------------------------------------------------

const base = fixtureDir("merge-test");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
let seq = 0;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

async function freshRepo(): Promise<string> {
  const dir = join(base, `t${seq++}`);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README"), "root\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "root");
  return dir;
}

/** A linked worktree on its own branch with `file` committed in it. */
async function workOn(root: string, branch: string, file: string, body: string): Promise<string> {
  const wt = join(root, ".wt", branch);
  await git(root, "worktree", "add", "-q", "-b", branch, wt, "HEAD");
  writeFileSync(join(wt, file), body);
  await git(wt, "add", "-A");
  await git(wt, "commit", "-q", "-m", `work on ${branch}`);
  return wt;
}

test("readMergeState sees a worktree's committed branch as ready", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-x", "feature.txt", "hello\n");
  const s = await readMergeState(wt);
  expect(s).toMatchObject({ repo: true, branch: "ag-x", base: "main", ahead: 1, dirty: false, ready: true });
});

test("readMergeState reports an uncommitted worktree as not ready", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-y", "feature.txt", "hello\n");
  writeFileSync(join(wt, "scratch.txt"), "wip\n");
  const s = await readMergeState(wt);
  expect(s).toMatchObject({ committed: true, ready: false, dirty: true });
});

test("a plain directory is simply not a repository", async () => {
  const dir = join(base, `plain${seq++}`);
  mkdirSync(dir, { recursive: true });
  const s = await readMergeState(dir);
  expect(s.repo).toBe(false);
  expect(s.committed).toBe(false);
  expect(await readMergeState("")).toMatchObject({ repo: false });
});

test("mergeWork lands the branch on main and leaves nothing to merge", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-z", "feature.txt", "hello\n");

  const r = await mergeWork(wt);
  expect(r).toMatchObject({ ok: true, branch: "ag-z", base: "main" });
  expect(existsSync(join(root, "feature.txt"))).toBe(true);

  const after = await readMergeState(wt);
  expect(after.ahead).toBe(0);
  expect(after.committed).toBe(false);
});

test("mergeWork makes a real merge commit, not a fast-forward", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-ff", "feature.txt", "hello\n");
  await mergeWork(wt);
  const p = Bun.spawn(["git", "-C", root, "log", "-1", "--pretty=%p %s"], { stdout: "pipe" });
  const line = (await new Response(p.stdout).text()).trim();
  expect(line.split(" ")[0]!.length).toBeGreaterThan(0);
  expect(line).toMatch(/Merge branch 'ag-ff'/);
});

test("a conflict is refused and the main checkout is left clean", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-c", "clash.txt", "from the branch\n");
  // main moves the same file underneath it
  writeFileSync(join(root, "clash.txt"), "from main\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "main writes clash");

  const r = await mergeWork(wt);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/could not merge ag-c into main/);
  expect(existsSync(join(root, ".git", "MERGE_HEAD"))).toBe(false);
});

test("mergeWork refuses when the main checkout is busy", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-busy", "feature.txt", "hello\n");
  writeFileSync(join(root, "README"), "edited\n");
  const r = await mergeWork(wt);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/uncommitted/);
});

// --- the queue: two merges into one checkout must not race -------------------

test("two branches merging at once both land, one after the other", async () => {
  const root = await freshRepo();
  const wt1 = await workOn(root, "ag-q1", "one.txt", "one\n");
  const wt2 = await workOn(root, "ag-q2", "two.txt", "two\n");

  // Fire both without awaiting between them — the serialization has to be the
  // queue's job, not the caller's. Without it these collide on the shared
  // checkout (index.lock, or a half-done merge poisoning the other's re-check).
  const [r1, r2] = await Promise.all([mergeWork(wt1), mergeWork(wt2)]);

  expect(r1.ok).toBe(true);
  expect(r2.ok).toBe(true);
  expect(existsSync(join(root, "one.txt"))).toBe(true);
  expect(existsSync(join(root, "two.txt"))).toBe(true);
});

test("readMergeState reports a merge in progress on the same root and holds the key", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-inflight", "feature.txt", "hello\n");
  const key = (await repoRoot(wt))!;

  // Occupy the queue for this root, as an in-flight merge would.
  let release!: () => void;
  const held = runExclusive(key, () => new Promise<void>((res) => { release = res; }));

  const during = await readMergeState(wt);
  expect(during.merging).toBe(true);
  expect(during.ready).toBe(false);
  expect(during.blocked).toMatch(/in progress/);

  release();
  await held;

  const after = await readMergeState(wt);
  expect(after.merging).toBe(false);
  expect(after.ready).toBe(true);
});

test("a branch already merged into the trunk reads as landed, not as nothing committed", () => {
  const v = mergeVerdict(facts({ ahead: 0, landed: true }));
  expect(v.committed).toBe(false);
  expect(v.blocked).toBe("ag-6 is already in main");
});

test("readMergeState sees a branch merged by hand as landed", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-hand", "feature.txt", "hello\n");
  await git(root, "merge", "-q", "--no-ff", "--no-edit", "ag-hand");
  const s = await readMergeState(wt);
  expect(s).toMatchObject({ ahead: 0, committed: false, landed: true, blocked: "ag-hand is already in main" });
});

test("a fresh branch with no commits of its own is not landed", async () => {
  const root = await freshRepo();
  const wt = join(root, ".wt", "ag-new");
  await git(root, "worktree", "add", "-q", "-b", "ag-new", wt, "HEAD");
  const s = await readMergeState(wt);
  expect(s).toMatchObject({ ahead: 0, committed: false, landed: false, blocked: "nothing committed on ag-new yet" });
});

// --- a detached main checkout (jj keeps git's HEAD this way) ----------------

async function out(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim();
}

test("mergeWork lands on main without touching a detached, dirty main checkout", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-jj", "feature.txt", "hello\n");
  await git(root, "checkout", "-q", "--detach");
  writeFileSync(join(root, "README"), "jj working copy\n");
  const head = await out(root, "rev-parse", "HEAD");

  expect(await readMergeState(wt)).toMatchObject({ ready: true, baseCheckedOut: false });
  const r = await mergeWork(wt);
  expect(r).toMatchObject({ ok: true, branch: "ag-jj", base: "main" });

  expect(await out(root, "log", "-1", "--pretty=%s", "main")).toBe("Merge branch 'ag-jj'");
  expect(r.commit).toBe(await out(root, "rev-parse", "main"));
  expect((await out(root, "rev-list", "--parents", "-1", "main")).split(" ")).toHaveLength(3);
  expect(await out(root, "show", "main:feature.txt")).toBe("hello");
  // The checkout is exactly as it was: same HEAD, edit still there.
  expect(await out(root, "rev-parse", "HEAD")).toBe(head);
  expect(await out(root, "status", "--porcelain", "--untracked-files=no")).toBe("M README");
  expect(await readMergeState(wt)).toMatchObject({ ahead: 0, committed: false, landed: true });
});

test("a conflict against a detached main checkout is refused and main does not move", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-jjc", "clash.txt", "from the branch\n");
  writeFileSync(join(root, "clash.txt"), "from main\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "main writes clash");
  await git(root, "checkout", "-q", "--detach");
  const before = await out(root, "rev-parse", "main");

  const r = await mergeWork(wt);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/could not merge ag-jjc into main/);
  expect(await out(root, "rev-parse", "main")).toBe(before);
});

// --- cleaning up after a merge ----------------------------------------------
// A worktree the dashboard made lives at <repo>/.claude/worktrees/<name>. Once
// its branch has landed and the tree is clean, both go; anything else stays and
// the result says why, so the card can too.

/** A worktree where the launcher puts one, with `file` committed on `branch`. */
async function agentWorktree(root: string, branch: string, file = "feature.txt"): Promise<string> {
  const wt = join(root, ".claude", "worktrees", branch);
  await git(root, "worktree", "add", "-q", "-b", branch, wt, "HEAD");
  await markWorktreeOwned(wt);
  writeFileSync(join(wt, file), `${branch}\n`);
  await git(wt, "add", "-A");
  await git(wt, "commit", "-q", "-m", `work on ${branch}`);
  return wt;
}

test("a clean, merged worktree and its branch are removed", async () => {
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-done");
  expect((await mergeWork(wt)).ok).toBe(true);

  expect(await cleanupMergedWork(wt, "ag-done")).toEqual({ removed: true, branchDeleted: true });
  expect(existsSync(wt)).toBe(false);
  expect(await out(root, "worktree", "list")).not.toContain("ag-done");
  expect(await out(root, "branch", "--list", "ag-done")).toBe("");
  // The merge itself is untouched.
  expect(await out(root, "show", "main:feature.txt")).toBe("ag-done");
});

test("files the repo ignores (the launcher's local settings) don't keep a worktree", async () => {
  const root = await freshRepo();
  writeFileSync(join(root, ".gitignore"), ".claude/settings.local.json\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "ignore local settings");
  const wt = await agentWorktree(root, "ag-ign");
  mkdirSync(join(wt, ".claude"), { recursive: true });
  writeFileSync(join(wt, ".claude", "settings.local.json"), "{}\n");
  expect((await mergeWork(wt)).ok).toBe(true);

  expect(await cleanupMergedWork(wt, "ag-ign")).toMatchObject({ removed: true });
  expect(existsSync(wt)).toBe(false);
});

test("the launcher's settings.local.json alone doesn't keep a worktree, even with no ignore rule anywhere", async () => {
  const root = await freshRepo();
  // Switch off this machine's global ignore (it lists settings.local.json).
  await git(root, "config", "core.excludesFile", "/dev/null");
  const wt = await agentWorktree(root, "ag-local");
  mkdirSync(join(wt, ".claude"), { recursive: true });
  writeFileSync(join(wt, ".claude", "settings.local.json"), "{}\n");
  expect((await mergeWork(wt)).ok).toBe(true);

  expect(await cleanupMergedWork(wt, "ag-local")).toMatchObject({ removed: true });
  expect(existsSync(wt)).toBe(false);
});

test("a clean, merged worktree the dashboard didn't make is left alone, silently", async () => {
  const root = await freshRepo();
  const wt = join(root, ".claude", "worktrees", "foreign");
  await git(root, "worktree", "add", "-q", "-b", "foreign", wt, "HEAD");
  writeFileSync(join(wt, "f.txt"), "f\n");
  await git(wt, "add", "-A");
  await git(wt, "commit", "-q", "-m", "foreign work");
  expect((await mergeWork(wt)).ok).toBe(true);

  expect(await cleanupMergedWork(wt, "foreign")).toEqual({ removed: false });
  expect(existsSync(wt)).toBe(true);
  expect(await out(root, "branch", "--list", "foreign")).toContain("foreign");
});

test("a dirty worktree is left alone and says why", async () => {
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-dirty");
  expect((await mergeWork(wt)).ok).toBe(true);
  writeFileSync(join(wt, "after.txt"), "written after the merge\n");

  const r = await cleanupMergedWork(wt, "ag-dirty");
  expect(r.removed).toBe(false);
  expect(r.why).toMatch(/uncommitted/);
  expect(existsSync(join(wt, "after.txt"))).toBe(true);
  expect(await out(root, "branch", "--list", "ag-dirty")).toContain("ag-dirty");
});

test("an unmerged branch is left alone and says why", async () => {
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-open");

  const r = await cleanupMergedWork(wt, "ag-open");
  expect(r.removed).toBe(false);
  expect(r.why).toMatch(/not merged into main/);
  expect(existsSync(wt)).toBe(true);
  expect(await out(root, "branch", "--list", "ag-open")).toContain("ag-open");
});

test("a worktree on a different branch than the one merged is left alone", async () => {
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-moved");
  expect((await mergeWork(wt)).ok).toBe(true);
  await git(wt, "checkout", "-q", "-b", "ag-next");

  const r = await cleanupMergedWork(wt, "ag-moved");
  expect(r.removed).toBe(false);
  expect(r.why).toMatch(/ag-next/);
  expect(existsSync(wt)).toBe(true);
});

test("the main checkout and worktrees outside .claude/worktrees are never touched, silently", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-elsewhere", "feature.txt", "hello\n");
  expect((await mergeWork(wt)).ok).toBe(true);

  expect(await cleanupMergedWork(wt, "ag-elsewhere")).toEqual({ removed: false });
  expect(existsSync(wt)).toBe(true);
  expect(await cleanupMergedWork(root, "main")).toEqual({ removed: false });
  expect(existsSync(join(root, "README"))).toBe(true);
});

test("a locked worktree is kept and the git error is the reason", async () => {
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-lock");
  expect((await mergeWork(wt)).ok).toBe(true);
  await git(root, "worktree", "lock", wt);

  const r = await cleanupMergedWork(wt, "ag-lock");
  expect(r.removed).toBe(false);
  expect(r.why).toMatch(/lock/);
  expect(existsSync(wt)).toBe(true);
  expect(await out(root, "branch", "--list", "ag-lock")).toContain("ag-lock");
});

test("a path that no longer exists is not an error", async () => {
  expect(await cleanupMergedWork(join(base, "gone-already"), "x")).toEqual({ removed: false });
});

test("with a detached main checkout the worktree goes but git branch -d keeps the branch, and says so", async () => {
  // `git branch -d` checks against HEAD, which a detached (jj) checkout leaves
  // behind the merge. We never fall back to -D.
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-jjd");
  await git(root, "checkout", "-q", "--detach");
  expect((await mergeWork(wt)).ok).toBe(true);

  const r = await cleanupMergedWork(wt, "ag-jjd");
  expect(r).toMatchObject({ removed: true, branchDeleted: false });
  expect(r.why).toMatch(/branch ag-jjd kept/);
  expect(existsSync(wt)).toBe(false);
  expect(await out(root, "branch", "--list", "ag-jjd")).toContain("ag-jjd");
});

// The tip the human saw rides along with the merge. A branch that moved since
// — even an amend that leaves the commit count alone — is refused, not landed.
async function tipOf(cwd: string): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, "rev-parse", "HEAD"], { stdout: "pipe" });
  return (await new Response(p.stdout).text()).trim();
}

test("readMergeState carries the branch tip SHA", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-tip", "feature.txt", "hello\n");
  expect((await readMergeState(wt)).tip).toBe(await tipOf(wt));
});

test("mergeWork refuses when the tip moved since it was seen, and lands nothing", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-amend", "feature.txt", "hello\n");
  const seen = await tipOf(wt);
  await git(wt, "commit", "-q", "--amend", "-m", "sneaky amend");
  const mainBefore = await tipOf(root);

  const r = await mergeWork(wt, { tip: seen });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/moved since you looked; review again/);
  expect(await tipOf(root)).toBe(mainBefore);
  expect(existsSync(join(root, "feature.txt"))).toBe(false);
});

test("mergeWork lands when the tip is the one that was seen", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-same", "feature.txt", "hello\n");
  expect(await mergeWork(wt, { tip: await tipOf(wt) })).toMatchObject({ ok: true, branch: "ag-same" });
});

test("mergeWork returns the merge commit it made, so the server knows what landed", async () => {
  const root = await freshRepo();
  const wt = await workOn(root, "ag-sha", "feature.txt", "hello\n");
  const r = await mergeWork(wt);
  expect(r.ok).toBe(true);
  expect(r.commit).toBe(await out(root, "rev-parse", "main"));
  expect(await out(root, "log", "-1", "--pretty=%s", r.commit!)).toBe("Merge branch 'ag-sha'");
});
