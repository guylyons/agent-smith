import { test, expect } from "bun:test";
import { mergeForWrite, scanLiveSessions, freshTranscripts, chooseLive, isEphemeralCwd } from "../src/scan";
import type { AgentStatus } from "../src/schema";
import { mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync, existsSync } from "node:fs";
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

test("mergeForWrite: writes the derived status when nothing exists", () => {
  const derived = S({ state: "idle" });
  expect(mergeForWrite(null, derived, 1000)).toBe(derived);
});

test("mergeForWrite: preserves a hook-set permission wait, only refreshing liveness", () => {
  const existing = S({ state: "waiting", waitingReason: "permission", updatedAt: 1000, doing: "needs approval" });
  const derived = S({ state: "idle", waitingReason: undefined, doing: "idle" });
  const out = mergeForWrite(existing, derived, 999_999);
  expect(out.state).toBe("waiting");
  expect(out.waitingReason).toBe("permission");
  expect(out.doing).toBe("needs approval");
  expect(out.updatedAt).toBe(999_999); // liveness refreshed so it doesn't age out
});

test("mergeForWrite: an ordinary existing status is replaced by the derived one", () => {
  const derived = S({ state: "working" });
  expect(mergeForWrite(S({ state: "idle" }), derived, 1000)).toBe(derived);
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

test("freshTranscripts filters by mtime and skips subagent subdirs", async () => {
  reset();
  const now = 10_000_000;
  writeTranscript("-repo", "fresh", [{ type: "assistant", sessionId: "fresh", cwd: "/repo", message: { content: [{ type: "text", text: "hi." }] } }], 60, now);
  writeTranscript("-repo", "stale", [{ type: "assistant", sessionId: "stale", cwd: "/repo", message: { content: [{ type: "text", text: "old." }] } }], 3600, now);
  // a subagent sidechain living in a subdir must be ignored
  mkdirSync(join(projects, "-repo", "sess", "subagents"), { recursive: true });
  writeFileSync(join(projects, "-repo", "sess", "subagents", "sub.jsonl"), JSON.stringify({ type: "assistant", sessionId: "sub", cwd: "/repo", message: { content: [] } }) + "\n");
  const found = (await freshTranscripts(now, 15 * 60_000)).map((f) => f.split("/").pop());
  expect(found).toContain("fresh.jsonl");
  expect(found).not.toContain("stale.jsonl");
  expect(found).not.toContain("sub.jsonl");
});

test("scanLiveSessions writes a status file per fresh session, keyed by sessionId", async () => {
  reset();
  const now = 20_000_000;
  writeTranscript("-repo", "sess1", [
    { type: "user", sessionId: "sess1", cwd: "/repo", gitBranch: "feature/4412-card", message: { content: [{ type: "text", text: "go" }] } },
    { type: "assistant", sessionId: "sess1", cwd: "/repo", gitBranch: "feature/4412-card", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/card.twig" } }] } },
  ], 30, now);
  const counts = { counts: new Map([["/repo", 1]]), ok: true };
  const n = await scanLiveSessions(now, 15 * 60_000, counts);
  expect(n).toBe(1);
  const written = JSON.parse(readFileSync(join(status, "sess1.json"), "utf8"));
  expect(written.sessionId).toBe("sess1");
  expect(written.state).toBe("working");
  expect(written.doing).toBe("editing card.twig");
  expect(written.ticket).toBe("#4412");
  expect(written.updatedAt).toBe(now);
});

test("scanLiveSessions keeps a fresh permission prompt alive without downgrading it", async () => {
  reset();
  const now = 30_000_000;
  writeTranscript("-repo", "sess2", [
    { type: "assistant", sessionId: "sess2", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "text", text: "All set." }] } },
  ], 30, now);
  // a hook already marked it needs-you (permission) a while ago
  writeFileSync(join(status, "sess2.json"), JSON.stringify(S({ sessionId: "sess2", state: "waiting", waitingReason: "permission", updatedAt: now - 500_000 })));
  await scanLiveSessions(now, 15 * 60_000, { counts: new Map([["/repo", 1]]), ok: true });
  const after = JSON.parse(readFileSync(join(status, "sess2.json"), "utf8"));
  expect(after.state).toBe("waiting");
  expect(after.waitingReason).toBe("permission");
  expect(after.updatedAt).toBe(now); // refreshed so it stays on the dashboard
});

const C = (sid: string, cwd: string, mtime: number) => ({ derived: S({ sessionId: sid, cwd }), mtime });

test("isEphemeralCwd flags tmp/scratchpad dirs", () => {
  expect(isEphemeralCwd("/private/tmp/claude-501/x/scratchpad")).toBe(true);
  expect(isEphemeralCwd("/tmp/whatever")).toBe(true);
  expect(isEphemeralCwd("/Users/glyons/github/mho-drupal")).toBe(false);
});

test("chooseLive caps sessions per cwd at the running-process count (newest win)", () => {
  const cands = [
    C("old", "/repo/a", 100),
    C("new", "/repo/a", 200),
    C("solo", "/repo/b", 50),
  ];
  const chosen = chooseLive(cands, new Map([["/repo/a", 1], ["/repo/b", 1]]), true);
  const ids = chosen.map((c) => c.sessionId).sort();
  expect(ids).toEqual(["new", "solo"]); // "old" dropped: only 1 process in /repo/a
});

test("chooseLive drops cwds with no running process, and ephemeral dirs", () => {
  const cands = [
    C("live", "/repo/a", 100),
    C("dead", "/repo/ghost", 100),
    C("tmp", "/private/tmp/claude-501/x/scratchpad", 100),
  ];
  const chosen = chooseLive(cands, new Map([["/repo/a", 1]]), true);
  expect(chosen.map((c) => c.sessionId)).toEqual(["live"]);
});

test("chooseLive falls back to all non-ephemeral when process info is unavailable", () => {
  const cands = [C("a", "/repo/a", 1), C("b", "/private/tmp/x", 1)];
  const chosen = chooseLive(cands, new Map(), false);
  expect(chosen.map((c) => c.sessionId)).toEqual(["a"]);
});

test("scanLiveSessions removes scanner-written phantoms but keeps hook-owned files", async () => {
  reset();
  const now = 40_000_000;
  writeTranscript("-repo", "live1", [
    { type: "assistant", sessionId: "live1", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "text", text: "hi." }] } },
  ], 30, now);
  // a stale scanner-written phantom (no pid) with no running process
  writeFileSync(join(status, "phantom.json"), JSON.stringify(S({ sessionId: "phantom", cwd: "/gone" })));
  // a hook-owned session (has pid) not in this scan — must be preserved
  writeFileSync(join(status, "hooked.json"), JSON.stringify(S({ sessionId: "hooked", cwd: "/elsewhere", pid: 1234 })));
  await scanLiveSessions(now, 15 * 60_000, { counts: new Map([["/repo", 1]]), ok: true });
  expect(existsSync(join(status, "live1.json"))).toBe(true);
  expect(existsSync(join(status, "phantom.json"))).toBe(false); // removed
  expect(existsSync(join(status, "hooked.json"))).toBe(true);   // hook-owned, kept
});
