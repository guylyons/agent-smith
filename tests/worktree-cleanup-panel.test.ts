// tests/worktree-cleanup-panel.test.ts — what CONFIG's worktree sweep says, DOM-free.
import { test, expect } from "bun:test";
import { sweepLine, sweepConfirmLabel, sweepButton, sweepStatus, type Sweep } from "../src/ui/SettingsPanel";

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

const wt = (branch: string) => ({ repo: "/r/proj", path: `/r/proj/.claude/worktrees/${branch}`, branch });
const plan = (remove: number, keep: number) => ({
  remove: Array.from({ length: remove }, (_, i) => wt(`go-${i}`)),
  keep: Array.from({ length: keep }, (_, i) => ({ ...wt(`stay-${i}`), why: "not merged" })),
});

test("sweepButton: one button walks look -> confirm -> remove, busy but never unmounted", () => {
  expect(sweepButton({ step: "idle" })).toEqual({ label: "🧹 CLEAN UP MERGED WORKTREES", danger: false, busy: false });
  expect(sweepButton({ step: "busy", doing: "checking" })).toEqual({ label: "CHECKING…", danger: false, busy: true });
  expect(sweepButton({ step: "confirm", plan: plan(2, 1) } as Sweep)).toEqual({ label: "REMOVE 2 WORKTREES", danger: true, busy: false });
  expect(sweepButton({ step: "busy", doing: "removing" })).toEqual({ label: "REMOVING…", danger: true, busy: true });
});

test("sweepButton: nothing to remove offers a fresh look", () => {
  expect(sweepButton({ step: "confirm", plan: plan(0, 3) } as Sweep).label).toBe("🧹 CLEAN UP MERGED WORKTREES");
});

test("sweepStatus: says what's happening and how it ended", () => {
  expect(sweepStatus({ step: "idle" })).toBe("");
  expect(sweepStatus({ step: "busy", doing: "checking" })).toBe("Checking worktrees…");
  expect(sweepStatus({ step: "busy", doing: "removing" })).toBe("Removing worktrees…");
  expect(sweepStatus({ step: "confirm", plan: plan(1, 2) } as Sweep)).toBe("1 worktree can go, 2 stay.");
  expect(sweepStatus({ step: "confirm", plan: plan(0, 2) } as Sweep)).toBe("Nothing to clean up.");
  expect(sweepStatus({ step: "done", result: { removed: [wt("a"), wt("b")].map((w) => ({ ...w, branchDeleted: true })), kept: [] } } as Sweep)).toBe("Removed 2 worktrees, kept 0.");
  expect(sweepStatus({ step: "error", error: "git failed" })).toBe("git failed");
});
