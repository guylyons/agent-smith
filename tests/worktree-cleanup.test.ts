import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { worktreeKeepReason, planWorktreeCleanup, cleanupMergedWorktrees } from "../src/lib/merge";

// The CONFIG sweep: worktrees merged by hand (git merge in a terminal) never
// went through MERGE, so nothing removed them. The sweep lists every one under
// <repo>/.claude/worktrees that is safe to remove, and removes only those.

const facts = { branch: "ag-x", base: "main", dirty: false, merged: true, live: false, locked: false };

test("a clean, merged, idle worktree has no reason to stay", () => {
  expect(worktreeKeepReason(facts)).toBe("");
});

test("each thing that makes a worktree unsafe to remove is named", () => {
  expect(worktreeKeepReason({ ...facts, live: true })).toMatch(/agent is working in it/);
  expect(worktreeKeepReason({ ...facts, dirty: true })).toMatch(/uncommitted changes/);
  expect(worktreeKeepReason({ ...facts, merged: false })).toMatch(/ag-x is not merged into main/);
  expect(worktreeKeepReason({ ...facts, branch: "" })).toMatch(/detached HEAD/);
  expect(worktreeKeepReason({ ...facts, base: "" })).toMatch(/no main branch/);
  expect(worktreeKeepReason({ ...facts, locked: true })).toMatch(/locked/);
});

test("a live agent outranks everything else as the reason", () => {
  // A fresh worktree sits at main's tip, so it reads as merged; the live check
  // is what keeps it, and that is the reason worth showing.
  expect(worktreeKeepReason({ ...facts, live: true, dirty: true, merged: false })).toMatch(/agent is working in it/);
});

const base = fixtureDir("worktree-cleanup-test");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
let seq = 0;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
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

/** A worktree where the launcher puts one; `commit` puts a file on its branch. */
async function agentWorktree(root: string, branch: string, commit = true, where = join(root, ".claude", "worktrees", branch)): Promise<string> {
  await git(root, "worktree", "add", "-q", "-b", branch, where, "HEAD");
  if (commit) {
    writeFileSync(join(where, `${branch}.txt`), `${branch}\n`);
    await git(where, "add", "-A");
    await git(where, "commit", "-q", "-m", `work on ${branch}`);
  }
  return where;
}

/** Merged the way a human does it in a terminal: not through MERGE. */
async function mergeByHand(root: string, branch: string): Promise<void> {
  await git(root, "merge", "-q", "--no-ff", "--no-edit", branch);
}

/** The mixed repo the card asks for: one of each kind of worktree. */
async function mixedRepo() {
  const root = await freshRepo();
  const done = await agentWorktree(root, "ag-done");
  await mergeByHand(root, "ag-done");
  const dirty = await agentWorktree(root, "ag-dirty");
  await mergeByHand(root, "ag-dirty");
  writeFileSync(join(dirty, "wip.txt"), "not committed\n");
  const open = await agentWorktree(root, "ag-open");
  const busy = await agentWorktree(root, "ag-busy");
  await mergeByHand(root, "ag-busy");
  // Just spawned: no commits yet, so it sits at main's tip and looks merged.
  const fresh = await agentWorktree(root, "ag-fresh", false);
  // Merged, clean, but not where the launcher puts worktrees: not ours.
  const elsewhere = await agentWorktree(root, "ag-elsewhere", true, join(base, `elsewhere${seq++}`));
  await mergeByHand(root, "ag-elsewhere");
  mkdirSync(join(busy, "src"), { recursive: true });
  const live = [join(busy, "src"), fresh, root];
  return { root, done, dirty, open, busy, fresh, elsewhere, live };
}

test("the plan lists only clean, merged, idle worktrees for removal and says why the rest stay", async () => {
  const r = await mixedRepo();
  const plan = await planWorktreeCleanup([r.root], r.live);

  expect(plan.remove.map((w) => w.branch)).toEqual(["ag-done"]);
  const why = Object.fromEntries(plan.keep.map((w) => [w.branch, w.why]));
  expect(Object.keys(why).sort()).toEqual(["ag-busy", "ag-dirty", "ag-fresh", "ag-open"]);
  expect(why["ag-busy"]).toMatch(/agent is working in it/);
  expect(why["ag-fresh"]).toMatch(/agent is working in it/);
  expect(why["ag-dirty"]).toMatch(/uncommitted changes/);
  expect(why["ag-open"]).toMatch(/not merged/);
  // Planning touches nothing.
  expect(existsSync(r.done)).toBe(true);
});

test("the main checkout and worktrees outside .claude/worktrees are never listed", async () => {
  const r = await mixedRepo();
  const plan = await planWorktreeCleanup([r.root], []);
  const paths = [...plan.remove, ...plan.keep].map((w) => w.path);
  expect(paths.every((p) => p.includes("/.claude/worktrees/"))).toBe(true);
  expect(paths.some((p) => p.includes("elsewhere"))).toBe(false);
});

test("the sweep removes only the clean, merged, idle worktree and its branch", async () => {
  const r = await mixedRepo();
  const res = await cleanupMergedWorktrees([r.root], r.live);

  expect(res.removed.map((w) => w.branch)).toEqual(["ag-done"]);
  expect(existsSync(r.done)).toBe(false);
  expect(await git(r.root, "branch", "--list", "ag-done")).toBe("");
  for (const kept of [r.dirty, r.open, r.busy, r.fresh, r.elsewhere]) expect(existsSync(kept)).toBe(true);
  expect(await git(r.root, "branch", "--list", "ag-open")).toContain("ag-open");
  expect(res.kept.map((w) => w.branch).sort()).toEqual(["ag-busy", "ag-dirty", "ag-fresh", "ag-open"]);
  // The uncommitted file is still there.
  expect(existsSync(join(r.dirty, "wip.txt"))).toBe(true);
});

test("the sweep only removes what the human confirmed, when given a list", async () => {
  const root = await freshRepo();
  const a = await agentWorktree(root, "ag-a");
  const b = await agentWorktree(root, "ag-b");
  await mergeByHand(root, "ag-a");
  await mergeByHand(root, "ag-b");
  const res = await cleanupMergedWorktrees([root], [], [a]);
  expect(res.removed.map((w) => w.branch)).toEqual(["ag-a"]);
  expect(existsSync(b)).toBe(true);
});

test("a confirmed worktree that stopped qualifying since the preview is kept, with the reason", async () => {
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-late");
  await mergeByHand(root, "ag-late");
  const plan = await planWorktreeCleanup([root], []);
  expect(plan.remove.map((w) => w.path)).toEqual([realpathSync(wt)]);
  // An agent starts work in it between the preview and the confirm.
  writeFileSync(join(wt, "new.txt"), "wip\n");
  const res = await cleanupMergedWorktrees([root], [], plan.remove.map((w) => w.path));
  expect(res.removed).toEqual([]);
  expect(res.kept[0]).toMatchObject({ branch: "ag-late" });
  expect(res.kept[0]!.why).toMatch(/uncommitted changes/);
  expect(existsSync(wt)).toBe(true);
});

test("repos are resolved to their root and de-duplicated; non-repos are skipped", async () => {
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-dup");
  await mergeByHand(root, "ag-dup");
  const plain = join(base, `plain${seq++}`);
  mkdirSync(plain, { recursive: true });
  const plan = await planWorktreeCleanup([root, wt, join(root, "."), plain, "", join(base, "missing")], []);
  expect(plan.remove.map((w) => w.branch)).toEqual(["ag-dup"]);
  expect(plan.remove[0]!.repo).toBe(root);
});

test("a locked worktree is kept and says so", async () => {
  const root = await freshRepo();
  const wt = await agentWorktree(root, "ag-lock");
  await mergeByHand(root, "ag-lock");
  await git(root, "worktree", "lock", wt);
  const plan = await planWorktreeCleanup([root], []);
  expect(plan.remove).toEqual([]);
  expect(plan.keep[0]!.why).toMatch(/locked/);
});
