// tests/worktree-cleanup-panel.test.ts — what CONFIG's worktree sweep says, DOM-free.
import { test, expect } from "bun:test";
import { sweepLine, sweepConfirmLabel } from "../src/ui/SettingsPanel";

test("a worktree is named by its repo and branch", () => {
  expect(sweepLine({ repo: "/Users/x/github/agent-smith", path: "/p", branch: "ag-done" })).toBe("agent-smith · ag-done");
});

test("a kept worktree carries the reason it stayed", () => {
  expect(sweepLine({ repo: "/r/proj", path: "/p", branch: "ag-open", why: "ag-open is not merged into main" }))
    .toBe("proj · ag-open — ag-open is not merged into main");
});

test("a detached worktree is named by its folder", () => {
  expect(sweepLine({ repo: "/r/proj", path: "/r/proj/.claude/worktrees/wt-9", branch: "" })).toBe("proj · wt-9");
});

test("a removed worktree whose branch git kept says so", () => {
  expect(sweepLine({ repo: "/r/proj", path: "/p", branch: "ag-j", branchDeleted: false, why: "branch ag-j kept: not fully merged" }))
    .toBe("proj · ag-j — branch ag-j kept: not fully merged");
});

test("the confirm names how many will go", () => {
  expect(sweepConfirmLabel(1)).toBe("REMOVE 1 WORKTREE");
  expect(sweepConfirmLabel(51)).toBe("REMOVE 51 WORKTREES");
});
