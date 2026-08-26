import { test, expect } from "bun:test";
import { deriveStatusFromTranscript } from "../src/lib/transcript";

const L = (o: object) => JSON.stringify(o);

test("returns null when no sessionId present", () => {
  expect(deriveStatusFromTranscript([L({ type: "system" })], 1)).toBeNull();
});

test("mid-tool session -> working with humanized doing", () => {
  const lines = [
    L({ type: "user", sessionId: "s1", cwd: "/repo", gitBranch: "feature/4412-card-component", message: { content: [{ type: "text", text: "build the card" }] } }),
    L({ type: "assistant", sessionId: "s1", cwd: "/repo", gitBranch: "feature/4412-card-component", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/card.twig" } }] } }),
  ];
  const s = deriveStatusFromTranscript(lines, 5000)!;
  expect(s.sessionId).toBe("s1");
  expect(s.state).toBe("working");
  expect(s.doing).toBe("editing card.twig");
  expect(s.ticket).toBe("#4412");
  expect(s.name).toBe("FORGE");
  expect(s.updatedAt).toBe(5000);
});

test("tool_result (user entry) still counts as working", () => {
  const lines = [
    L({ type: "assistant", sessionId: "s1", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } }),
    L({ type: "user", sessionId: "s1", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "tool_result", content: "ok" }] } }),
  ];
  const s = deriveStatusFromTranscript(lines, 1)!;
  expect(s.state).toBe("working");
  expect(s.doing).toBe("running bun test");
});

test("a thinking block after a tool_use shows 'thinking', not the stale tool action", () => {
  const lines = [
    L({ type: "assistant", sessionId: "s1", cwd: "/r", gitBranch: "b", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/r/a.ts" } }] } }),
    L({ type: "user", sessionId: "s1", cwd: "/r", gitBranch: "b", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    L({ type: "assistant", sessionId: "s1", cwd: "/r", gitBranch: "b", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
  ];
  const s = deriveStatusFromTranscript(lines, 1)!;
  expect(s.state).toBe("working");
  expect(s.doing).toBe("thinking");
});

test("assistant ended turn with a question -> waiting/question", () => {
  const lines = [
    L({ type: "assistant", sessionId: "s1", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "text", text: "Which variant should I use — featured or compact?" }] } }),
  ];
  const s = deriveStatusFromTranscript(lines, 1)!;
  expect(s.state).toBe("waiting");
  expect(s.waitingReason).toBe("question");
  expect(s.doing).toBe("waiting on your answer");
});

test("assistant ended turn with a statement -> idle", () => {
  const lines = [
    L({ type: "assistant", sessionId: "s1", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "text", text: "All done, tests pass." }] } }),
  ];
  const s = deriveStatusFromTranscript(lines, 1)!;
  expect(s.state).toBe("idle");
  expect(s.waitingReason).toBeUndefined();
});

test("sidechain/meta entries are ignored", () => {
  const lines = [
    L({ type: "assistant", isSidechain: true, sessionId: "sub", cwd: "/x", message: { content: [{ type: "text", text: "subagent noise?" }] } }),
    L({ type: "assistant", sessionId: "s1", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "text", text: "Real done." }] } }),
  ];
  const s = deriveStatusFromTranscript(lines, 1)!;
  expect(s.sessionId).toBe("s1");
  expect(s.state).toBe("idle");
});

test("captures aiTitle as the session title (used to target the Ghostty tab)", () => {
  const lines = [
    L({ type: "assistant", sessionId: "s1", cwd: "/repo", gitBranch: "b", aiTitle: "Primary nav menu panels links", message: { content: [{ type: "text", text: "done." }] } }),
  ];
  expect(deriveStatusFromTranscript(lines, 1)!.title).toBe("Primary nav menu panels links");
});

test("null/empty gitBranch -> null ticket", () => {
  const lines = [
    L({ type: "assistant", sessionId: "s1", cwd: "/repo", gitBranch: "", message: { content: [{ type: "text", text: "done." }] } }),
  ];
  const s = deriveStatusFromTranscript(lines, 1)!;
  expect(s.branch).toBeNull();
  expect(s.ticket).toBeNull();
});
