import { test, expect } from "bun:test";
import { pushRecent, mergeRecent, parseRecent, MAX_RECENT, projectFolder, worktreeRoot } from "../src/ui/recentFolders";
import { folderLabels, launchSummary } from "../src/ui/NewAgentModal";

test("pushRecent moves a folder to the front instead of duplicating it", () => {
  expect(pushRecent(["/a", "/b"], "/b")).toEqual(["/b", "/a"]);
  expect(pushRecent(["/a"], "/c")).toEqual(["/c", "/a"]);
});

test("pushRecent caps the history and ignores a blank folder", () => {
  const many = Array.from({ length: 12 }, (_, i) => `/p${i}`);
  expect(pushRecent(many, "/new").length).toBe(MAX_RECENT);
  expect(pushRecent(["/a"], "   ")).toEqual(["/a"]);
});

test("mergeRecent puts remembered folders first and de-dupes the live ones", () => {
  expect(mergeRecent(["/a", "/b"], ["/b", "/c"])).toEqual(["/a", "/b", "/c"]);
  expect(mergeRecent([], ["/x"])).toEqual(["/x"]);
});

test("parseRecent survives junk in storage", () => {
  expect(parseRecent('["/a","/b"]')).toEqual(["/a", "/b"]);
  expect(parseRecent("not json")).toEqual([]);
  expect(parseRecent('{"a":1}')).toEqual([]);
  expect(parseRecent('["/a",7,null,"  "]')).toEqual(["/a"]);
});

test("folderLabels shows just the repo name until two of them collide", () => {
  expect(folderLabels(["/Users/me/work/api", "/Users/me/site"])).toEqual(["api", "site"]);
  expect(folderLabels(["/Users/me/work/api", "/Users/me/fork/api"])).toEqual(["work/api", "fork/api"]);
});

test("launchSummary spells out each worktree/branch combination", () => {
  expect(launchSummary("", "")).toContain("whatever branch it is on now");
  expect(launchSummary("Fix Thing", "")).toBe("Isolated worktree .claude/worktrees/fix-thing, on branch fix-thing.");
  expect(launchSummary("Fix Thing", "feat/x")).toBe("Isolated worktree .claude/worktrees/fix-thing, on branch feat/x.");
  expect(launchSummary("", "feat/x")).toBe("The folder itself, switched to branch feat/x.");
});

test("launchSummary warns rather than pretending an unusable name works", () => {
  expect(launchSummary("!!!", "")).toContain("no letters or numbers");
  expect(launchSummary("", "///")).toContain("no letters or numbers");
});

test("worktreeRoot maps an agent's worktree back to its repo", () => {
  expect(worktreeRoot("/src/shop/.claude/worktrees/fix-cart")).toBe("/src/shop");
  expect(worktreeRoot("/src/shop/.claude/worktrees/fix-cart/")).toBe("/src/shop");
  expect(worktreeRoot("/src/shop")).toBe("/src/shop");
});

test("projectFolder prefers the last launch, then a live agent's repo", () => {
  expect(projectFolder(["/a", "/b"], ["/c"])).toBe("/a");
  expect(projectFolder([], ["", "/c/.claude/worktrees/x"])).toBe("/c");
  expect(projectFolder(["/d/.claude/worktrees/y"], [])).toBe("/d");
  expect(projectFolder([], [])).toBe("");
});

test("mergeRecent shows a repo once, not once per agent worktree", () => {
  const live = ["/src/shop/.claude/worktrees/fix-cart", "/src/shop/.claude/worktrees/ux-review", "/src/blog"];
  expect(mergeRecent([], live)).toEqual(["/src/shop", "/src/blog"]);
  expect(mergeRecent(["/src/shop"], live)).toEqual(["/src/shop", "/src/blog"]);
});

test("parseRecent drops old saved worktree entries in favour of their repo", () => {
  expect(parseRecent('["/src/shop/.claude/worktrees/ux-review","/src/shop","/src/blog"]'))
    .toEqual(["/src/shop", "/src/blog"]);
  expect(parseRecent('["/src/shop/.claude/worktrees/a","/src/shop/.claude/worktrees/b"]')).toEqual(["/src/shop"]);
});

test("pushRecent remembers a worktree launch as its repo", () => {
  expect(pushRecent(["/a", "/src/shop"], "/src/shop/.claude/worktrees/x")).toEqual(["/src/shop", "/a"]);
});

test("worktreeRoot maps a folder inside a worktree to its repo", () => {
  expect(worktreeRoot("/x/api/.claude/worktrees/foo/src")).toBe("/x/api");
  expect(worktreeRoot("/x/api/.claude/worktrees/foo/src/lib/")).toBe("/x/api");
});

test("worktreeRoot drops trailing slashes but keeps a bare root", () => {
  expect(worktreeRoot("/a/b/")).toBe("/a/b");
  expect(worktreeRoot("/a/b//")).toBe("/a/b");
  expect(worktreeRoot("~/")).toBe("~");
  expect(worktreeRoot("/")).toBe("/");
});

test("a folder with and without a trailing slash is one chip", () => {
  expect(mergeRecent(["/a/b"], ["/a/b/"])).toEqual(["/a/b"]);
  expect(pushRecent(["/a/b/", "/c"], "/a/b")).toEqual(["/a/b", "/c"]);
  expect(parseRecent('["/a/b/","/a/b"]')).toEqual(["/a/b"]);
});
