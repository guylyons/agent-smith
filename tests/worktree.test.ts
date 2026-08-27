import { test, expect } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../src/lib/slug";
import { createWorktree } from "../src/lib/worktree";

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

const base = "/tmp/aw-worktree-test";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

async function freshRepo(): Promise<string> {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  await git(base, "init", "-q", "-b", "main");
  await git(base, "config", "user.email", "t@t");
  await git(base, "config", "user.name", "t");
  await git(base, "commit", "-q", "--allow-empty", "-m", "root");
  return base;
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
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  const r = await createWorktree(base, "x");
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
});
