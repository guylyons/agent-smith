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

test("Stop with a question -> waiting/question, else idle", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const q = applyEvent(s0, { hook_event_name: "Stop", session_id: "s1", cwd: "/repo", branch: start.branch, last_message: "Which variant should I use?" } as any, 4000)!;
  expect(q.state).toBe("waiting");
  expect(q.waitingReason).toBe("question");
  const done = applyEvent(s0, { hook_event_name: "Stop", session_id: "s1", cwd: "/repo", branch: start.branch, last_message: "Done." } as any, 4000)!;
  expect(done.state).toBe("idle");
});

test("SessionEnd -> null (delete)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  expect(applyEvent(s0, { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 5000)).toBeNull();
});
