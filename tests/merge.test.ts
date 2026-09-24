import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mergeVerdict, readMergeState, mergeWork, repoRoot, type MergeFacts } from "../src/lib/merge";
import { runExclusive } from "../src/lib/merge-queue";

// --- the rules, without a repo ---------------------------------------------

const facts = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  repo: true, branch: "ag-6", base: "main", ahead: 2, dirty: false,
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
