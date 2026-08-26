import { test, expect } from "bun:test";
import { shouldWrite, scanLiveSessions, freshTranscripts } from "../src/scan";
import type { AgentStatus } from "../src/schema";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";

const base = "/tmp/aw-scan-test";
const projects = join(base, "projects");
const status = join(base, "status");

function reset() {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(projects, { recursive: true });
  mkdirSync(status, { recursive: true });
  process.env.AGENT_PROJECTS_DIR = projects;
  process.env.AGENT_STATUS_DIR = status;
}

const S = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 0, ...o,
});

test("shouldWrite: writes when nothing exists", () => {
  expect(shouldWrite(null, 1000)).toBe(true);
});

test("shouldWrite: preserves a fresh hook permission prompt", () => {
  const existing = S({ waitingReason: "permission", updatedAt: 1000 });
  expect(shouldWrite(existing, 1000 + 60_000)).toBe(false); // within sticky window
});

test("shouldWrite: overwrites a stale permission prompt", () => {
  const existing = S({ waitingReason: "permission", updatedAt: 1000 });
  expect(shouldWrite(existing, 1000 + 200_000)).toBe(true); // past sticky window
});

test("shouldWrite: overwrites ordinary existing status", () => {
  expect(shouldWrite(S({ state: "idle" }), 1000)).toBe(true);
});

function writeTranscript(proj: string, sid: string, lines: object[], mtimeSecAgo = 0, now = Date.now()) {
  const dir = join(projects, proj);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const when = (now - mtimeSecAgo * 1000) / 1000;
  utimesSync(file, when, when);
  return file;
}

test("freshTranscripts filters by mtime and skips subagent subdirs", () => {
  reset();
  const now = 10_000_000;
  writeTranscript("-repo", "fresh", [{ type: "assistant", sessionId: "fresh", cwd: "/repo", message: { content: [{ type: "text", text: "hi." }] } }], 60, now);
  writeTranscript("-repo", "stale", [{ type: "assistant", sessionId: "stale", cwd: "/repo", message: { content: [{ type: "text", text: "old." }] } }], 3600, now);
  // a subagent sidechain living in a subdir must be ignored
  mkdirSync(join(projects, "-repo", "subagents"), { recursive: true });
  writeFileSync(join(projects, "-repo", "subagents", "sub.jsonl"), JSON.stringify({ type: "assistant", sessionId: "sub", cwd: "/repo", message: { content: [] } }) + "\n");
  const found = freshTranscripts(now, 15 * 60_000).map((f) => f.split("/").pop());
  expect(found).toContain("fresh.jsonl");
  expect(found).not.toContain("stale.jsonl");
  expect(found).not.toContain("sub.jsonl");
});

test("scanLiveSessions writes a status file per fresh session, keyed by sessionId", () => {
  reset();
  const now = 20_000_000;
  writeTranscript("-repo", "sess1", [
    { type: "user", sessionId: "sess1", cwd: "/repo", gitBranch: "feature/4412-card", message: { content: [{ type: "text", text: "go" }] } },
    { type: "assistant", sessionId: "sess1", cwd: "/repo", gitBranch: "feature/4412-card", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/card.twig" } }] } },
  ], 30, now);
  const n = scanLiveSessions(now, 15 * 60_000);
  expect(n).toBe(1);
  const written = JSON.parse(readFileSync(join(status, "sess1.json"), "utf8"));
  expect(written.sessionId).toBe("sess1");
  expect(written.state).toBe("working");
  expect(written.doing).toBe("editing card.twig");
  expect(written.ticket).toBe("#4412");
  expect(written.updatedAt).toBe(now);
});

test("scanLiveSessions does not clobber a fresh permission prompt", () => {
  reset();
  const now = 30_000_000;
  writeTranscript("-repo", "sess2", [
    { type: "assistant", sessionId: "sess2", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "text", text: "All set." }] } },
  ], 30, now);
  // a hook already marked it needs-you (permission), moments ago
  writeFileSync(join(status, "sess2.json"), JSON.stringify(S({ sessionId: "sess2", state: "waiting", waitingReason: "permission", updatedAt: now - 10_000 })));
  scanLiveSessions(now, 15 * 60_000);
  const after = JSON.parse(readFileSync(join(status, "sess2.json"), "utf8"));
  expect(after.state).toBe("waiting");
  expect(after.waitingReason).toBe("permission");
});
