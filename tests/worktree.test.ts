import { test, expect } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { slugify, slugifyBranch } from "../src/lib/slug";
import { createWorktree, createBranch, prepareLaunch } from "../src/lib/worktree";

test("slugify turns a task into a branch-safe slug", () => {
  expect(slugify("Fix the phantom agent bug")).toBe("fix-the-phantom-agent-bug");
  expect(slugify("  Add WORKTREE support!!  ")).toBe("add-worktree-support");
  expect(slugify("café / naïve — 100%")).toBe("caf-na-ve-100");
});

test("slugify caps length and word count, no trailing dash", () => {
  const s = slugify("one two three four five six seven eight nine ten");
  expect(s).toBe("one-two-three-four-five-six");
  expect(s.endsWith("-")).toBe(false);
  expect(slugify("supercalifragilisticexpialidocious-and-then-some-extra-words").length).toBeLessThanOrEqual(40);
});

test("slugify returns empty string when nothing usable remains", () => {
  expect(slugify("!!! ??? ---")).toBe("");
  expect(slugify("")).toBe("");
});

// --- createWorktree against a throwaway git repo ---

// Every test gets its OWN directory under here. They used to share one path,
// which raced: git's background housekeeping from the previous test could still
// be holding the .git dir when the next test wiped and re-initialised it, so a
// setup commit would fail silently and the test after it saw an unborn branch.
const base = "/tmp/aw-worktree-test";
// Wipe the whole scratch root once per run: an older layout left a repo AT this
// path, and a leftover .git there would be discovered from the dirs below it —
// making the "not a git repository" tests pass a repo in without noticing.
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
let seq = 0;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

/** An empty directory of its own — no git repo in it, nor above it. */
function emptyDir(): string {
  const dir = join(base, `t${seq++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function freshRepo(): Promise<string> {
  const dir = emptyDir();
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "root");
  return dir;
}

test("createWorktree makes an isolated worktree + branch off HEAD", async () => {
  const repo = await freshRepo();
  const r = await createWorktree(repo, "fix-thing");
  expect(r.ok).toBe(true);
  expect(r.branch).toBe("fix-thing");
  expect(r.path).toBe(join(repo, ".claude", "worktrees", "fix-thing"));
  expect(existsSync(r.path!)).toBe(true);
});

test("createWorktree slugifies the requested name", async () => {
  const repo = await freshRepo();
  const r = await createWorktree(repo, "Fix The Thing!");
  expect(r.ok).toBe(true);
  expect(r.branch).toBe("fix-the-thing");
});

test("createWorktree errors (does not throw) on a duplicate name", async () => {
  const repo = await freshRepo();
  expect((await createWorktree(repo, "dup")).ok).toBe(true);
  const second = await createWorktree(repo, "dup");
  expect(second.ok).toBe(false);
  expect(second.error).toBeTruthy();
});

test("createWorktree errors on an empty/unusable name", async () => {
  const repo = await freshRepo();
  const r = await createWorktree(repo, "!!!");
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
});

test("createWorktree errors when cwd is not a git repo", async () => {
  const r = await createWorktree(emptyDir(), "x");
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
});

test("slugifyBranch keeps namespace slashes and drops empty segments", () => {
  expect(slugifyBranch("feat/Add The Thing")).toBe("feat/add-the-thing");
  expect(slugifyBranch("//fix//AG 1//")).toBe("fix/ag-1");
  expect(slugifyBranch("../../escape")).toBe("escape");
  expect(slugifyBranch("!!!")).toBe("");
});

// --- naming the branch as well as (or instead of) the worktree ---

async function currentBranch(cwd: string): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, "branch", "--show-current"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

test("createWorktree puts the worktree on a separately named branch", async () => {
  const repo = await freshRepo();
  const r = await createWorktree(repo, "my dir", "feat/My Branch");
  expect(r.ok).toBe(true);
  expect(r.path).toBe(join(repo, ".claude", "worktrees", "my-dir"));
  expect(r.branch).toBe("feat/my-branch");
  expect(await currentBranch(r.path!)).toBe("feat/my-branch");
});

test("createWorktree checks out an existing branch rather than failing on it", async () => {
  const repo = await freshRepo();
  await git(repo, "branch", "already-here");
  const r = await createWorktree(repo, "wt", "already-here");
  expect(r.ok).toBe(true);
  expect(r.branch).toBe("already-here");
  expect(await currentBranch(r.path!)).toBe("already-here");
});

test("createWorktree rejects a branch name with nothing usable in it", async () => {
  const repo = await freshRepo();
  const r = await createWorktree(repo, "wt", "!!!");
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
});

test("createBranch switches the folder itself, no worktree", async () => {
  const repo = await freshRepo();
  const r = await createBranch(repo, "Feature Work");
  expect(r.ok).toBe(true);
  expect(r.path).toBe(repo);
  expect(r.branch).toBe("feature-work");
  expect(await currentBranch(repo)).toBe("feature-work");
  expect(existsSync(join(repo, ".claude", "worktrees"))).toBe(false);
});

test("createBranch reuses an existing branch and no-ops when already on it", async () => {
  const repo = await freshRepo();
  expect((await createBranch(repo, "twice")).ok).toBe(true);
  const again = await createBranch(repo, "twice");
  expect(again.ok).toBe(true);
  expect(await currentBranch(repo)).toBe("twice");
});

test("createBranch errors when cwd is not a git repo", async () => {
  const r = await createBranch(emptyDir(), "x");
  expect(r.ok).toBe(false);
});

test("prepareLaunch with neither name leaves the folder exactly as it is", async () => {
  const repo = await freshRepo();
  const before = await currentBranch(repo);
  const r = await prepareLaunch(repo, {});
  expect(r).toEqual({ ok: true, path: repo });
  expect(await currentBranch(repo)).toBe(before);
});

test("prepareLaunch routes each combination to the right shape", async () => {
  const repo = await freshRepo();
  const both = await prepareLaunch(repo, { worktree: "wt", branch: "b1" });
  expect(both.path).toBe(join(repo, ".claude", "worktrees", "wt"));
  expect(both.branch).toBe("b1");
  expect(both.worktreeCreated).toBe(true);

  const wtOnly = await prepareLaunch(repo, { worktree: "solo", branch: "   " });
  expect(wtOnly.branch).toBe("solo");

  const brOnly = await prepareLaunch(repo, { branch: "b2" });
  expect(brOnly.path).toBe(repo);
  expect(brOnly.branch).toBe("b2");
  expect(brOnly.worktreeCreated).toBeUndefined();
});
