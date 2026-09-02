import { test, expect } from "bun:test";
import { mergeForWrite, scanLiveSessions, freshTranscripts, chooseLive, isEphemeralCwd, readConversation, budgetTotalOf, isClaudeComm, isSessionHostComm, parseProcessTable, processInfoOk, type GhosttyTerminal } from "../src/scan";
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

// Ghostty terminal list "unavailable" -- tests below exercise scanLiveSessions'
// process-count path deterministically, independent of whatever Ghostty windows
// happen to be open on the machine running the test.
const NO_GHOSTTY: { terminals: GhosttyTerminal[]; ok: boolean } = { terminals: [], ok: false };

test("mergeForWrite: writes the derived status when nothing exists", () => {
  const derived = S({ state: "idle" });
  // a first sighting stamps stateSince = now
  expect(mergeForWrite(null, derived, 1000)).toEqual({ ...derived, stateSince: 1000 });
});

test("mergeForWrite: carries stateSince while the state is unchanged, resets on a transition", () => {
  const existing = S({ state: "working", stateSince: 500 });
  expect(mergeForWrite(existing, S({ state: "working" }), 2000).stateSince).toBe(500);
  expect(mergeForWrite(existing, S({ state: "idle" }), 2000).stateSince).toBe(2000);
});

test("mergeForWrite: preserves a hook-set permission wait while still mid-tool, only refreshing liveness", () => {
  // A permission-blocked session sits on an unresolved tool_use, which the
  // transcript derives as "working" -- that must NOT overwrite the pin, since the
  // permission prompt is invisible in the transcript.
  const existing = S({ state: "waiting", waitingReason: "permission", updatedAt: 1000, doing: "needs approval" });
  const derived = S({ state: "working", waitingReason: undefined, doing: "running a command" });
  const out = mergeForWrite(existing, derived, 999_999);
  expect(out.state).toBe("waiting");
  expect(out.waitingReason).toBe("permission");
  expect(out.doing).toBe("needs approval");
  expect(out.updatedAt).toBe(999_999); // liveness refreshed so it doesn't age out
});

test("mergeForWrite: releases a permission pin once the transcript shows a completed turn", () => {
  // "idle" means the transcript ended on assistant text -- a finished turn, which
  // cannot coexist with a pending permission prompt. The pin is provably stale
  // (e.g. the Stop hook didn't fire), so the derived idle wins.
  const existing = S({ state: "waiting", waitingReason: "permission", updatedAt: 1000, doing: "needs approval" });
  const derived = S({ state: "idle", waitingReason: undefined, doing: "idle", updatedAt: 999_999 });
  const out = mergeForWrite(existing, derived, 999_999);
  expect(out.state).toBe("idle");
  expect(out.waitingReason).toBeUndefined();
  expect(out.doing).toBe("idle");
});

test("mergeForWrite: a pending question overrides a stale permission pin", () => {
  // A pending AskUserQuestion is a definitive transcript signal; showing a stale
  // "permission" badge over it would desync the card from the answer drawer.
  const existing = S({ state: "waiting", waitingReason: "permission", updatedAt: 1000, doing: "needs approval" });
  const derived = S({ state: "waiting", waitingReason: "question", doing: "waiting on your answer", updatedAt: 999_999 });
  const out = mergeForWrite(existing, derived, 999_999);
  expect(out.state).toBe("waiting");
  expect(out.waitingReason).toBe("question");
  expect(out.doing).toBe("waiting on your answer");
});

test("mergeForWrite: a released permission pin still carries hook-set pid/tty forward", () => {
  const existing = S({ state: "waiting", waitingReason: "permission", pid: 4242, tty: "/dev/ttys006" });
  const derived = S({ state: "idle", waitingReason: undefined, doing: "idle" }); // transcript-derived, no pid/tty
  const out = mergeForWrite(existing, derived, 1000);
  expect(out.state).toBe("idle");   // pin released
  expect(out.pid).toBe(4242);       // but the hook's pid/tty survive
  expect(out.tty).toBe("/dev/ttys006");
});

test("mergeForWrite: carries hook-set pid/tty forward when the derived status lacks them", () => {
  const existing = S({ state: "waiting", pid: 4242, tty: "/dev/ttys006" });
  const derived = S({ state: "working" }); // transcript-derived, no pid/tty
  const out = mergeForWrite(existing, derived, 1000);
  expect(out.state).toBe("working"); // state still tracks the transcript
  expect(out.pid).toBe(4242);        // but the hook's pid/tty survive
  expect(out.tty).toBe("/dev/ttys006");
});

test("mergeForWrite: a hook-set plan block survives a scanner-derived working", () => {
  const existing = S({ state: "waiting", waitingReason: "plan", updatedAt: 1000, doing: "waiting on plan approval" });
  const derived = S({ state: "working", waitingReason: undefined, doing: "exitplanmode" });
  const out = mergeForWrite(existing, derived, 5000);
  expect(out.state).toBe("waiting");
  expect(out.waitingReason).toBe("plan");
  expect(out.updatedAt).toBe(5000);
});

test("mergeForWrite: a plan block IS released once the transcript goes idle", () => {
  const existing = S({ state: "waiting", waitingReason: "plan", updatedAt: 1000, doing: "waiting on plan approval" });
  const derived = S({ state: "idle", waitingReason: undefined, doing: "idle", updatedAt: 999_999 });
  const out = mergeForWrite(existing, derived, 5000);
  expect(out.state).toBe("idle");
  expect(out.waitingReason).toBeUndefined();
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
  const n = await scanLiveSessions(now, 15 * 60_000, counts, NO_GHOSTTY);
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
  // A permission-blocked session sits on an unresolved tool_use (derives to
  // "working"); the pin must survive that so the card keeps saying needs-you.
  writeTranscript("-repo", "sess2", [
    { type: "assistant", sessionId: "sess2", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "rm -rf build" } }] } },
  ], 30, now);
  // a hook already marked it needs-you (permission) a while ago
  writeFileSync(join(status, "sess2.json"), JSON.stringify(S({ sessionId: "sess2", state: "waiting", waitingReason: "permission", updatedAt: now - 500_000 })));
  await scanLiveSessions(now, 15 * 60_000, { counts: new Map([["/repo", 1]]), ok: true }, NO_GHOSTTY);
  const after = JSON.parse(readFileSync(join(status, "sess2.json"), "utf8"));
  expect(after.state).toBe("waiting");
  expect(after.waitingReason).toBe("permission");
  expect(after.updatedAt).toBe(now); // refreshed so it stays on the dashboard
});

test("scanLiveSessions releases a permission pin when the session has since finished its turn", async () => {
  reset();
  const now = 31_000_000;
  // The turn ended on assistant text -> the permission was already answered; a
  // stale pin (e.g. a Stop hook that never fired) must not keep it as needs-you.
  writeTranscript("-repo", "sess3", [
    { type: "assistant", sessionId: "sess3", cwd: "/repo", gitBranch: "b", message: { content: [{ type: "text", text: "All set." }] } },
  ], 30, now);
  writeFileSync(join(status, "sess3.json"), JSON.stringify(S({ sessionId: "sess3", state: "waiting", waitingReason: "permission", updatedAt: now - 500_000 })));
  await scanLiveSessions(now, 15 * 60_000, { counts: new Map([["/repo", 1]]), ok: true }, NO_GHOSTTY);
  const after = JSON.parse(readFileSync(join(status, "sess3.json"), "utf8"));
  expect(after.state).toBe("idle");
  expect(after.waitingReason).toBeUndefined();
});

const C = (sid: string, cwd: string, mtime: number) => ({ derived: S({ sessionId: sid, cwd }), mtime });

test("isEphemeralCwd flags tmp/scratchpad dirs", () => {
  expect(isEphemeralCwd("/private/tmp/claude-501/x/scratchpad")).toBe(true);
  expect(isEphemeralCwd("/tmp/whatever")).toBe(true);
  expect(isEphemeralCwd("/Users/guy/github/mho-drupal")).toBe(false);
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

// A candidate with a title (mirrors ghostty.ts targeting: title equals/ends-with a
// Ghostty terminal's tab name).
const CTitle = (sid: string, cwd: string, mtime: number, title: string) => ({ derived: S({ sessionId: sid, cwd, title }), mtime });
const T = (cwd: string, name: string): GhosttyTerminal => ({ cwd, name });

test("chooseLive: 3 candidates in one cwd but only 1 matching Ghostty terminal title -> only that 1 is chosen", () => {
  const cands = [
    CTitle("orphan1", "/repo/a", 300, "Some other closed tab"),
    CTitle("real", "/repo/a", 100, "Brand color background variables"),
    CTitle("orphan2", "/repo/a", 200, "Yet another stale session"),
  ];
  // ps still reports 3 running processes in this cwd (the phantom bug), but only
  // one Ghostty terminal is actually open there.
  const counts = new Map([["/repo/a", 3]]);
  const ghostty = { terminals: [T("/repo/a", "✳ Brand color background variables")], ok: true };
  const chosen = chooseLive(cands, counts, true, ghostty);
  expect(chosen.map((c) => c.sessionId)).toEqual(["real"]);
});

test("chooseLive: sessions matched by title across two cwds", () => {
  const cands = [
    CTitle("a1", "/repo/a", 100, "Cross-site header mobile nav sizing"),
    CTitle("a2", "/repo/a", 200, "Primary nav menu panels links"),
    CTitle("b1", "/repo/b", 100, "MHO-Drupal ticket review"),
  ];
  const counts = new Map([["/repo/a", 2], ["/repo/b", 1]]);
  const ghostty = {
    terminals: [
      T("/repo/a", "✳ Cross-site header mobile nav sizing"),
      T("/repo/a", "✳ Primary nav menu panels links"),
      T("/repo/b", "✳ MHO-Drupal ticket review"),
    ],
    ok: true,
  };
  const chosen = chooseLive(cands, counts, true, ghostty).map((c) => c.sessionId).sort();
  expect(chosen).toEqual(["a1", "a2", "b1"]);
});

test("chooseLive: osascript-unavailable fallback still returns process-capped sessions (doesn't blank)", () => {
  const cands = [
    C("old", "/repo/a", 100),
    C("new", "/repo/a", 200),
  ];
  const counts = new Map([["/repo/a", 1]]);
  // Ghostty query failed (osascript unavailable / Ghostty not running).
  const ghostty = { terminals: [] as GhosttyTerminal[], ok: false };
  const chosen = chooseLive(cands, counts, true, ghostty);
  expect(chosen.map((c) => c.sessionId)).toEqual(["new"]); // process-count cap, newest wins
});

test("chooseLive: with Ghostty available, an untitled candidate falls back to remaining-terminal-count cap", () => {
  const cands = [
    C("older", "/repo/a", 100),
    C("newer", "/repo/a", 200),
  ];
  const counts = new Map([["/repo/a", 2]]);
  const ghostty = { terminals: [T("/repo/a", "~/repo/a")], ok: true }; // 1 plain, untitled terminal open
  const chosen = chooseLive(cands, counts, true, ghostty);
  expect(chosen.map((c) => c.sessionId)).toEqual(["newer"]);
});

test("chooseLive: an untitled candidate is NOT surfaced when a leftover tab outlives its process", () => {
  // Real scenario: one live claude (titled, matched to its tab) plus an ended
  // session (untitled, transcript still fresh) whose old tab is still open as a
  // plain shell. ps counts only the 1 live process. The dead session must not be
  // surfaced just because non-claude tabs (dev server, shells) are open in the cwd.
  const cands = [
    CTitle("marlow", "/repo/a", 200, "Issue investigation"),
    C("otter", "/repo/a", 100), // untitled, ended session
  ];
  const counts = new Map([["/repo/a", 1]]); // only ONE running claude process
  const ghostty = {
    terminals: [
      T("/repo/a", "bun run dev"),
      T("/repo/a", "◑ Issue investigation"), // marlow's live tab
      T("/repo/a", "~/repo/a"),              // otter's old tab, now a shell
      T("/repo/a", "v"),
    ],
    ok: true,
  };
  const chosen = chooseLive(cands, counts, true, ghostty).map((c) => c.sessionId);
  expect(chosen).toEqual(["marlow"]);
});

test("chooseLive: a lingering titled tab whose process died does not hide a fresher live session", () => {
  // n=1 running claude. A dead session's tab still shows its old title (title
  // lingers after the process exits), and a genuinely-live untitled session is
  // being actively written (fresher mtime). Capping at n and preferring the
  // freshest transcript must surface the live one, not the stale phantom.
  const cands = [
    CTitle("phantom", "/repo/b", 100, "Old task"), // dead process, title still on its tab
    C("live", "/repo/b", 200),                      // live session, untitled tab, fresher
  ];
  const counts = new Map([["/repo/b", 1]]); // one running claude process
  const ghostty = {
    terminals: [T("/repo/b", "◑ Old task"), T("/repo/b", "~/repo/b")],
    ok: true,
  };
  const chosen = chooseLive(cands, counts, true, ghostty).map((c) => c.sessionId);
  expect(chosen).toEqual(["live"]);
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
  await scanLiveSessions(now, 15 * 60_000, { counts: new Map([["/repo", 1]]), ok: true }, NO_GHOSTTY);
  expect(existsSync(join(status, "live1.json"))).toBe(true);
  expect(existsSync(join(status, "phantom.json"))).toBe(false); // removed
  expect(existsSync(join(status, "hooked.json"))).toBe(true);   // hook-owned, kept
});

test("readConversation reports the blocking tool", async () => {
  reset();
  const dir = join(projects, "-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sessB.jsonl"), [
    JSON.stringify({ type: "assistant", sessionId: "sessB", cwd: "/repo", message: { content: [{ type: "text", text: "one moment" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "sessB", cwd: "/repo", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "rm -rf build" } }] } }),
  ].join("\n"));
  const conv = await readConversation("sessB");
  expect(conv.question).toBeNull();
  expect(conv.blocked).toEqual({ name: "Bash", summary: "running rm -rf build" });
});

test("mergeForWrite carries the persona forward like pid/tty", () => {
  const existing = S({ persona: "backend-dev", pid: 42 });
  const derived = S({});
  const merged = mergeForWrite(existing, derived, 5000);
  expect(merged.persona).toBe("backend-dev");
  expect(merged.pid).toBe(42);
});

test("mergeForWrite: carries a known budget forward when the derived tail lost its marker", () => {
  const existing = S({ usage: { budgetLeft: 14_000_000, budgetTotal: 15_000_000 } });
  const derived = S({ state: "working" }); // tail window happened to show no marker
  expect(mergeForWrite(existing, derived, 1000).usage).toEqual({ budgetLeft: 14_000_000, budgetTotal: 15_000_000 });
});

test("mergeForWrite: a permission pin still takes the fresher budget reading", () => {
  const existing = S({ state: "waiting", waitingReason: "permission", usage: { budgetLeft: 14_000_000, budgetTotal: 15_000_000 } });
  const derived = S({ state: "working", usage: { budgetLeft: 13_500_000, budgetTotal: 15_000_000 } });
  const out = mergeForWrite(existing, derived, 1000);
  expect(out.waitingReason).toBe("permission"); // pin kept
  expect(out.usage).toEqual({ budgetLeft: 13_500_000, budgetTotal: 15_000_000 });
});

test("budgetTotalOf: reads the session's FIRST marker from the transcript head", async () => {
  reset();
  const file = join(projects, "p", "budget.jsonl");
  mkdirSync(join(projects, "p"), { recursive: true });
  writeFileSync(file, [
    JSON.stringify({ type: "user", sessionId: "s9", cwd: "/r", message: { content: [{ type: "text", text: "<total_tokens>15000000 tokens left</total_tokens>" }] } }),
    JSON.stringify({ type: "user", sessionId: "s9", cwd: "/r", message: { content: [{ type: "text", text: "<total_tokens>14000000 tokens left</total_tokens>" }] } }),
  ].join("\n"));
  expect(await budgetTotalOf(file)).toBe(15_000_000);
});

test("budgetTotalOf: null for a transcript without markers or a missing file", async () => {
  reset();
  const file = join(projects, "p", "nobudget.jsonl");
  mkdirSync(join(projects, "p"), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "user", sessionId: "s9", cwd: "/r", message: { content: [{ type: "text", text: "hi" }] } }));
  expect(await budgetTotalOf(file)).toBe(null);
  expect(await budgetTotalOf(join(projects, "p", "missing.jsonl"))).toBe(null);
});

// --- liveness: a session that dies without a SessionEnd hook (crash, force
// quit, tab close) leaves its status file behind forever, because the cleanup
// pass only ever removed scanner-written (pid-less) files. ------------------

test("isClaudeComm: matches a full-path claude, not an unrelated process", () => {
  expect(isClaudeComm("claude")).toBe(true);
  expect(isClaudeComm("/Users/guy/.local/bin/claude")).toBe(true); // seen in the wild
  expect(isClaudeComm("node")).toBe(false);
  expect(isClaudeComm("/Applications/Claude.app/Contents/MacOS/Claude")).toBe(false);
});

test("isSessionHostComm: a known session's pid may be hosted by a shim", () => {
  expect(isSessionHostComm("claude")).toBe(true);
  expect(isSessionHostComm("/Users/guy/.local/bin/claude")).toBe(true);
  expect(isSessionHostComm("node")).toBe(true); // npm-shim install
  expect(isSessionHostComm("bun")).toBe(true);
  expect(isSessionHostComm("Google Chrome")).toBe(false); // recycled pid
});

test("scanLiveSessions removes a hook-owned status file whose process is gone", async () => {
  reset();
  const now = 40_000_000;
  writeFileSync(join(status, "dead.json"), JSON.stringify(S({ sessionId: "dead", cwd: "/repo", pid: 4242 })));
  await scanLiveSessions(now, 15 * 60_000,
    { counts: new Map([["/repo", 1]]), ok: true, procs: new Map([[99, "claude"]]) }, NO_GHOSTTY);
  expect(existsSync(join(status, "dead.json"))).toBe(false);
});

test("scanLiveSessions keeps a hook-owned status file whose process is still running", async () => {
  reset();
  const now = 40_000_000;
  writeFileSync(join(status, "alive.json"), JSON.stringify(S({ sessionId: "alive", cwd: "/elsewhere", pid: 4242 })));
  await scanLiveSessions(now, 15 * 60_000,
    { counts: new Map([["/repo", 1]]), ok: true, procs: new Map([[4242, "/opt/homebrew/bin/claude"]]) }, NO_GHOSTTY);
  expect(existsSync(join(status, "alive.json"))).toBe(true);
});

test("scanLiveSessions keeps a hook-owned file hosted by a shim (node/bun), not just bare claude", async () => {
  reset();
  const now = 40_000_000;
  writeFileSync(join(status, "shim.json"), JSON.stringify(S({ sessionId: "shim", cwd: "/elsewhere", pid: 4242 })));
  await scanLiveSessions(now, 15 * 60_000,
    { counts: new Map([["/repo", 1]]), ok: true, procs: new Map([[4242, "node"]]) }, NO_GHOSTTY);
  expect(existsSync(join(status, "shim.json"))).toBe(true);
});

test("scanLiveSessions removes a hook-owned file whose pid was recycled by something else", async () => {
  reset();
  const now = 40_000_000;
  writeFileSync(join(status, "recycled.json"), JSON.stringify(S({ sessionId: "recycled", cwd: "/repo", pid: 4242 })));
  await scanLiveSessions(now, 15 * 60_000,
    { counts: new Map([["/repo", 1]]), ok: true, procs: new Map([[4242, "Google Chrome"]]) }, NO_GHOSTTY);
  expect(existsSync(join(status, "recycled.json"))).toBe(false);
});

test("scanLiveSessions keeps hook-owned files when process info is unavailable", async () => {
  reset();
  const now = 40_000_000;
  writeFileSync(join(status, "hooked.json"), JSON.stringify(S({ sessionId: "hooked", cwd: "/elsewhere", pid: 4242 })));
  // no `procs` at all -> ps unreadable -> never delete on a guess
  await scanLiveSessions(now, 15 * 60_000, { counts: new Map([["/repo", 1]]), ok: true }, NO_GHOSTTY);
  expect(existsSync(join(status, "hooked.json"))).toBe(true);
  // an empty (but present) table is equally untrustworthy
  await scanLiveSessions(now, 15 * 60_000,
    { counts: new Map([["/repo", 1]]), ok: true, procs: new Map() }, NO_GHOSTTY);
  expect(existsSync(join(status, "hooked.json"))).toBe(true);
});

test("parseProcessTable: finds claude sessions by basename, ignoring headless helpers", () => {
  const psout = [
    "  90025 ttys004  claude",
    "  47726 ??       /Users/guy/.local/bin/claude --chrome-native-host",
    "  95426 ttys003  /Users/guy/.local/bin/claude",
    "  12345 ??       /Applications/Claude.app/Contents/MacOS/Claude",
    "  54321 ttys009  node",
  ].join("\n");
  const { procs, sessionPids } = parseProcessTable(psout);
  // full-path claude in a terminal counts; the detached --chrome-native-host
  // helper and the desktop app do not
  expect(sessionPids).toEqual(["90025", "95426"]);
  // every process lands in the liveness table, session or not
  expect(procs.get(47726)).toBe("/Users/guy/.local/bin/claude --chrome-native-host");
  expect(procs.get(54321)).toBe("node");
  expect(procs.size).toBe(5);
});

test("parseProcessTable: unusable ps output yields an empty table (callers keep everything)", () => {
  const { procs, sessionPids } = parseProcessTable("");
  expect(procs.size).toBe(0);
  expect(sessionPids).toEqual([]);
});

// --- closing your LAST session must empty the board, not fill it. Before the
// fix below, "ps ran fine and found no claude sessions" was reported as
// ok:false — the same value as "we couldn't read the process table at all" —
// so chooseLive took its never-blank-the-board fallback and resurrected every
// transcript touched in the last 15 minutes as a live agent. ---------------

test("processInfoOk: a usable process table with zero sessions is a fact, not a failure", () => {
  const procs = new Map([[1, "launchd"], [2, "Google Chrome"]]);
  expect(processInfoOk(procs, [], new Map())).toBe(true);
});

test("processInfoOk: an unreadable process table is untrustworthy", () => {
  expect(processInfoOk(new Map(), [], new Map())).toBe(false);
});

test("processInfoOk: sessions found but no cwd resolved (lsof failed) is untrustworthy", () => {
  expect(processInfoOk(new Map([[1, "claude"]]), ["1"], new Map())).toBe(false);
});

test("processInfoOk: sessions with resolved cwds are trustworthy", () => {
  expect(processInfoOk(new Map([[1, "claude"]]), ["1"], new Map([["/repo", 1]]))).toBe(true);
});

test("scanLiveSessions: with no session running, recent transcripts do NOT come back as agents", async () => {
  reset();
  const now = 40_000_000;
  // three sessions that are over, all touched within the freshness window
  for (const sid of ["gone1", "gone2", "gone3"]) {
    writeTranscript("-repo", sid, [
      { type: "assistant", sessionId: sid, cwd: "/repo", gitBranch: "b", message: { content: [{ type: "text", text: "done." }] } },
    ], 60, now);
  }
  // the one just closed left a hook-written file behind (no SessionEnd on a tab close)
  writeFileSync(join(status, "gone1.json"), JSON.stringify(S({ sessionId: "gone1", cwd: "/repo", pid: 4242 })));
  const procs = new Map([[1, "launchd"], [2, "Google Chrome"]]); // ps fine, no claude
  const n = await scanLiveSessions(now, 15 * 60_000,
    { counts: new Map(), ok: processInfoOk(procs, [], new Map()), procs }, NO_GHOSTTY);
  expect(n).toBe(0);
  expect(existsSync(join(status, "gone1.json"))).toBe(false);
  expect(existsSync(join(status, "gone2.json"))).toBe(false);
  expect(existsSync(join(status, "gone3.json"))).toBe(false);
});

test("mergeForWrite carries the crew the hook set, so a scan pass can't drop the desk's name", () => {
  const base = { sessionId: "s", name: "HASHED", role: "r", ticket: null, state: "working" as const, doing: "", cwd: "/", branch: null, updatedAt: 0 };
  const existing = { ...base, crew: { id: "ripley-1", name: "RIPLEY" } };
  expect(mergeForWrite(existing, base, 5).crew).toEqual({ id: "ripley-1", name: "RIPLEY" });
  expect(mergeForWrite(null, base, 5).crew).toBeUndefined();
});
