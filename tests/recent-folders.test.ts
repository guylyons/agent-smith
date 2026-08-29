import { test, expect } from "bun:test";
import { pushRecent, mergeRecent, parseRecent, MAX_RECENT } from "../src/ui/recentFolders";
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
