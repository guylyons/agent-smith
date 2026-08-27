// tests/hook-status.test.ts
import { test, expect } from "bun:test";
import { applyEvent } from "../hooks/status";

const start = {
  hook_event_name: "SessionStart", session_id: "s1",
  cwd: "/repo", branch: "feature/4412-card-component",
};

test("SessionStart seeds a working agent with ticket+role", () => {
  const s = applyEvent(null, start as any, 1000)!;
  expect(s.state).toBe("working");
  expect(s.ticket).toBe("#4412");
  expect(s.name).toBe("FORGE");
  expect(s.sessionId).toBe("s1");
});

test("PreToolUse updates the doing line", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s1 = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "Edit", tool_input: { file_path: "/a/card.twig" },
  } as any, 2000)!;
  expect(s1.doing).toBe("editing card.twig");
  expect(s1.updatedAt).toBe(2000);
});

test("Notification -> waiting/permission", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, { hook_event_name: "Notification", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 3000)!;
  expect(s.state).toBe("waiting");
  expect(s.waitingReason).toBe("permission");
});

test("Stop -> idle even if the final message ends with '?' (a prose '?' is not a reliable question; real AskUserQuestion is scanner-detected)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const q = applyEvent(s0, { hook_event_name: "Stop", session_id: "s1", cwd: "/repo", branch: start.branch, last_assistant_message: "Which variant should I use?" } as any, 4000)!;
  expect(q.state).toBe("idle");
  expect(q.waitingReason).toBeUndefined();
  const done = applyEvent(s0, { hook_event_name: "Stop", session_id: "s1", cwd: "/repo", branch: start.branch, last_assistant_message: "Done." } as any, 4000)!;
  expect(done.state).toBe("idle");
});

test("SessionEnd -> null (delete)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  expect(applyEvent(s0, { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 5000)).toBeNull();
});

test("SessionStart records a persona from the env", () => {
  const s = applyEvent(null, start as any, 1000, "frontend-ux")!;
  expect(s.persona).toBe("frontend-ux");
});

test("no persona when the env var is absent", () => {
  expect(applyEvent(null, start as any, 1000)!.persona).toBeUndefined();
  expect(applyEvent(null, start as any, 1000, "")!.persona).toBeUndefined();
});

test("an invalid persona id is dropped", () => {
  expect(applyEvent(null, start as any, 1000, "Bad Id!")!.persona).toBeUndefined();
  expect(applyEvent(null, start as any, 1000, "../escape")!.persona).toBeUndefined();
});

test("persona survives later events", () => {
  const s0 = applyEvent(null, start as any, 1000, "backend-dev")!;
  const s1 = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "Edit", tool_input: { file_path: "/a/x.ts" },
  } as any, 2000)!;
  expect(s1.persona).toBe("backend-dev");
  const s2 = applyEvent(s1, { hook_event_name: "Stop", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 3000)!;
  expect(s2.persona).toBe("backend-dev");
});

test("PreToolUse on AskUserQuestion -> waiting/question immediately", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "AskUserQuestion", tool_input: { questions: [] },
  } as any, 2000)!;
  expect(s.state).toBe("waiting");
  expect(s.waitingReason).toBe("question");
  expect(s.doing).toBe("waiting on your answer");
});

test("PreToolUse on ExitPlanMode -> waiting/plan immediately", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "ExitPlanMode", tool_input: {},
  } as any, 2000)!;
  expect(s.state).toBe("waiting");
  expect(s.waitingReason).toBe("plan");
  expect(s.doing).toBe("waiting on plan approval");
});

test("PreToolUse on an ordinary tool is still working (regression)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "Edit", tool_input: { file_path: "/a/card.twig" },
  } as any, 2000)!;
  expect(s.state).toBe("working");
  expect(s.waitingReason).toBeUndefined();
  expect(s.doing).toBe("editing card.twig");
});

test("Notification sets doing, not just state (no stale tool line)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const busy = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "Bash", tool_input: { command: "rm -rf build" },
  } as any, 2000)!;
  const s = applyEvent(busy, {
    hook_event_name: "Notification", session_id: "s1", cwd: "/repo", branch: start.branch,
  } as any, 3000)!;
  expect(s.waitingReason).toBe("permission");
  expect(s.doing).toBe("needs permission");
});
