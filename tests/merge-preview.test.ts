import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPreview, fileChange, isEmptyPreview, moreLine, parseCommits, parseNumstat, previewSummary, startsOpen,
  MAX_COMMITS, MAX_FILES,
} from "../src/lib/mergePreview";
import { readMergePreview } from "../src/lib/merge";

// --- the formatting, without a repo -----------------------------------------

test("parseCommits splits sha from subject, keeping tabs inside the subject", () => {
  expect(parseCommits("abc1234\tAdd thing\ndef5678\tFix\ta tab\n")).toEqual([
    { sha: "abc1234", subject: "Add thing" },
    { sha: "def5678", subject: "Fix\ta tab" },
  ]);
  expect(parseCommits("")).toEqual([]);
});

test("parseNumstat reads counts, and a binary file as null", () => {
  expect(parseNumstat("12\t3\tsrc/a.ts\n-\t-\timg.png\n0\t5\told name\twith tab")).toEqual([
    { path: "src/a.ts", added: 12, removed: 3 },
    { path: "img.png", added: null, removed: null },
    { path: "old name\twith tab", added: 0, removed: 5 },
  ]);
});

test("buildPreview caps the lists but counts and sums everything", () => {
  const log = Array.from({ length: 25 }, (_, i) => `sha${i}\tcommit ${i}`).join("\n");
  const numstat = Array.from({ length: 60 }, (_, i) => `2\t1\tf${i}`).join("\n");
  const p = buildPreview({ branch: "ag", base: "main", log, totalCommits: 30, numstat });
  expect(p.commits).toHaveLength(MAX_COMMITS);
  expect(p.totalCommits).toBe(30);
  expect(p.files).toHaveLength(MAX_FILES);
  expect(p.totalFiles).toBe(60);
  expect([p.insertions, p.deletions]).toEqual([120, 60]);
  expect(moreLine(p.commits.length, p.totalCommits, "commit")).toBe("and 10 more commits");
  expect(moreLine(p.files.length, p.totalFiles, "file")).toBe("and 10 more files");
  expect(moreLine(50, 51, "file")).toBe("and 1 more file");
  expect(moreLine(3, 3, "file")).toBe("");
  expect(startsOpen(p)).toBe(false);
});

test("the summary line, singular and plural", () => {
  const one = buildPreview({ branch: "ag", base: "main", log: "a\tx", totalCommits: 1, numstat: "4\t0\tREADME" });
  expect(previewSummary(one)).toBe("1 commit · 1 file · +4 −0");
  expect(startsOpen(one)).toBe(true);
  const noFiles = buildPreview({ branch: "ag", base: "main", log: "a\tx\nb\ty", totalCommits: 2, numstat: "" });
  expect(previewSummary(noFiles)).toBe("2 commits");
});

test("a binary file reads as binary, a text one as +/-", () => {
  expect(fileChange({ path: "p", added: null, removed: null })).toBe("binary");
  expect(fileChange({ path: "p", added: 3, removed: 9 })).toBe("+3 −9");
});

test("no commits is an empty preview (the card shows nothing)", () => {
  expect(isEmptyPreview(buildPreview({ branch: "ag", base: "main", log: "", totalCommits: 0, numstat: "" }))).toBe(true);
});

// --- against a throwaway repo -----------------------------------------------

const base = fixtureDir("merge-preview-test");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
let seq = 0;

function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-C", cwd, ...args]).stdout.toString().trim();
}

function freshRepo(): string {
  const dir = join(base, `t${seq++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README"), "root\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "root");
  return dir;
}

test("readMergePreview matches git log main..branch and git diff --stat main...branch", async () => {
  const root = freshRepo();
  const wt = join(root, ".wt", "ag");
  git(root, "worktree", "add", "-q", "-b", "ag", wt, "HEAD");
  writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
  git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", "add a");
  writeFileSync(join(wt, "README"), "changed\n");
  git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", "edit readme");
  // A commit on main after the fork must not show: that's base...branch.
  writeFileSync(join(root, "main-only.txt"), "x\n");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "main moved");

  const p = await readMergePreview(wt);
  if ("error" in p) throw new Error(p.error);
  expect(p).toMatchObject({ branch: "ag", base: "main", totalCommits: 2, totalFiles: 2, insertions: 3, deletions: 1 });
  expect(p.commits.map((c) => `${c.sha} ${c.subject}`).join("\n")).toBe(git(wt, "log", "--oneline", "main..ag"));
  expect(p.files.map((f) => f.path).sort()).toEqual(["README", "a.txt"]);
});

test("readMergePreview on a branch with nothing new is empty; outside a repo it errors", async () => {
  const root = freshRepo();
  const wt = join(root, ".wt", "idle");
  git(root, "worktree", "add", "-q", "-b", "idle", wt, "HEAD");
  const p = await readMergePreview(wt);
  expect("error" in p ? p.error : isEmptyPreview(p)).toBe(true);

  const plain = join(base, `plain${seq++}`);
  mkdirSync(plain, { recursive: true });
  expect(await readMergePreview(plain)).toEqual({ error: "not a git repository" });
});

test("readMergePreview carries the branch tip SHA", async () => {
  const root = freshRepo();
  const wt = join(root, ".wt", "tipped");
  git(root, "worktree", "add", "-q", "-b", "tipped", wt, "HEAD");
  writeFileSync(join(wt, "a.txt"), "one\n");
  git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", "add a");
  const p = await readMergePreview(wt);
  if ("error" in p) throw new Error(p.error);
  expect(p.tip).toBe(git(wt, "rev-parse", "HEAD"));
});
