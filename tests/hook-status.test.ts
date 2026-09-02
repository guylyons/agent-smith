// tests/hook-status.test.ts
import { test, expect } from "bun:test";
import { applyEvent } from "../hooks/status";

const start = {
  hook_event_name: "SessionStart", session_id: "s1",
  cwd: "/repo", branch: "feature/4412-card-component",
};

test("SessionStart seeds an IDLE agent with ticket+role: nothing is happening until a prompt arrives", () => {
  const s = applyEvent(null, start as any, 1000)!;
  expect(s.state).toBe("idle");
  expect(s.doing).toBe("ready");
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

test("Notification -> waiting/permission (no type: an older Claude Code, treated as a permission prompt)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, { hook_event_name: "Notification", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 3000)!;
  expect(s.state).toBe("waiting");
  expect(s.waitingReason).toBe("permission");
});

test("a permission_prompt or an MCP elicitation dialog is a wait on the user", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  for (const t of ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]) {
    const s = applyEvent(s0, { hook_event_name: "Notification", notification_type: t, session_id: "s1", cwd: "/repo", branch: start.branch } as any, 3000)!;
    expect(s.state).toBe("waiting");
    expect(s.waitingReason).toBe("permission");
  }
});

test("idle_prompt and the other notification types leave the state alone", () => {
  const working = applyEvent(applyEvent(null, start as any, 1000), {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo", branch: start.branch, tool_name: "Read", tool_input: { file_path: "/a" },
  } as any, 2000)!;
  for (const t of ["idle_prompt", "auth_success", "agent_completed", "quota_auto_resume_fired"]) {
    const s = applyEvent(working, { hook_event_name: "Notification", notification_type: t, session_id: "s1", cwd: "/repo", branch: start.branch } as any, 3000)!;
    expect(s.state).toBe("working");
    expect(s.waitingReason).toBeUndefined();
    expect(s.doing).toBe("reading a");
    expect(s.updatedAt).toBe(3000);
  }
});

test("UserPromptSubmit -> working/thinking: the turn has begun", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, { hook_event_name: "UserPromptSubmit", prompt: "build the card", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 1500)!;
  expect(s.state).toBe("working");
  expect(s.doing).toBe("thinking");
  expect(s.waitingReason).toBeUndefined();
  expect(s.stateSince).toBe(1500);
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

// A pending AskUserQuestion is NEVER in the transcript while it blocks — Claude Code
// flushes it only once answered, backdated. The hook's PreToolUse payload is the only
// live source, so it must survive onto the status record.
test("PreToolUse on AskUserQuestion captures the questions and options", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo", branch: start.branch,
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ header: "Probe", question: "Which colour?", multiSelect: false,
      options: [{ label: "Alpha", description: "the first" }, { label: "Beta" }] }] },
  } as any, 2000)!;
  expect(s.pendingQuestion!.questions).toHaveLength(1);
  const q = s.pendingQuestion!.questions[0];
  expect(q.question).toBe("Which colour?");
  expect(q.header).toBe("Probe");
  expect(q.options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
  expect(q.options[0].description).toBe("the first");
});

test("a malformed AskUserQuestion payload yields no pendingQuestion, never a broken record", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo", branch: start.branch,
    tool_name: "AskUserQuestion", tool_input: { questions: "not an array" },
  } as any, 2000)!;
  expect(s.state).toBe("waiting");
  expect(s.pendingQuestion).toBeUndefined();
});

test("the captured question is cleared once the wait ends", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const asked = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo", branch: start.branch,
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "q", options: [{ label: "A" }] }] },
  } as any, 2000)!;
  expect(asked.pendingQuestion).toBeDefined();
  // answered -> the session moves on to another tool
  const next = applyEvent(asked, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo", branch: start.branch,
    tool_name: "Edit", tool_input: { file_path: "/a/b.ts" },
  } as any, 3000)!;
  expect(next.pendingQuestion).toBeUndefined();
  // and a turn that simply ends also clears it
  expect(applyEvent(asked, { hook_event_name: "Stop", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 3000)!.pendingQuestion).toBeUndefined();
});

test("a later event re-stamps the persona onto a prev that lost it", () => {
  // A scanner pass can write the status file without the persona (it doesn't
  // know it); the next hook event must heal it from the env, not carry the loss.
  const start = { hook_event_name: "SessionStart", session_id: "s1", cwd: "/x", branch: null };
  const strippedPrev = { ...applyEvent(null, start as any, 1000, "frontend-ux")! };
  delete (strippedPrev as any).persona;
  const tool = { hook_event_name: "PreToolUse", session_id: "s1", cwd: "/x", branch: null, tool_name: "Bash", tool_input: {} };
  const next = applyEvent(strippedPrev, tool as any, 2000, "frontend-ux")!;
  expect(next.persona).toBe("frontend-ux");
});

test("re-stamping never overwrites a persona already on prev", () => {
  const start = { hook_event_name: "SessionStart", session_id: "s1", cwd: "/x", branch: null };
  const prev = applyEvent(null, start as any, 1000, "frontend-ux")!;
  const tool = { hook_event_name: "PreToolUse", session_id: "s1", cwd: "/x", branch: null, tool_name: "Bash", tool_input: {} };
  // env var vanished mid-session (shouldn't happen, but the stored value wins)
  expect(applyEvent(prev, tool as any, 2000, undefined)!.persona).toBe("frontend-ux");
});

test("stateSince is stamped on seed and carried while the state holds", () => {
  const start = { hook_event_name: "SessionStart", session_id: "s1", cwd: "/x", branch: null };
  const tool = { hook_event_name: "PreToolUse", session_id: "s1", cwd: "/x", branch: null, tool_name: "Bash", tool_input: {} };
  const a = applyEvent(null, start as any, 1000)!;
  expect(a.stateSince).toBe(1000); // idle, at an empty prompt
  const b = applyEvent(a, tool as any, 5000)!;
  expect(b.stateSince).toBe(5000); // idle -> working resets
  const b2 = applyEvent(b, tool as any, 7000)!;
  expect(b2.stateSince).toBe(5000); // still working — carried
  const stop = { hook_event_name: "Stop", session_id: "s1", cwd: "/x", branch: null };
  const c = applyEvent(b2, stop as any, 9000)!;
  expect(c.stateSince).toBe(9000); // working -> idle resets
});

test("SessionStart resets stateSince even when the state string matches", () => {
  const start = { hook_event_name: "SessionStart", session_id: "s1", cwd: "/x", branch: null };
  const a = applyEvent(null, start as any, 1000)!; // working
  const b = applyEvent(a, start as any, 8000)!;    // a fresh session, also working
  expect(b.stateSince).toBe(8000);
});

// ---- Stop: drain the board inbox and hand it back as the reason to go on ---
// Board events that arrived while the session was busy wait in the server's
// inbox. On Stop the hook collects them and, if there are any, answers Claude
// Code with a block decision whose reason is the batch — so the agent reads
// them as its next instruction without anything being typed into its pty.

import { stopDecision, drainInbox } from "../hooks/status";

test("stopDecision with nothing queued lets the turn end", () => {
  expect(stopDecision([])).toBeNull();
});

test("stopDecision with queued items blocks the stop and carries them as the reason", () => {
  const d = stopDecision(["[THE LINE] You commented on \"T\":\nhello", "[THE LINE] You moved \"T\" to \"in-progress\"."]);
  expect(d!.decision).toBe("block");
  expect(d!.reason).toContain("hello");
  expect(d!.reason).toContain("in-progress");
  expect(d!.reason.startsWith("Board notifications arrived while you were working")).toBe(true);
});

test("drainInbox asks the dashboard for this session's items and returns them", async () => {
  const calls: { url: string; body: any }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, items: ["a", "b"] }), { status: 200 });
  }) as unknown as typeof fetch;
  expect(await drainInbox("http://localhost:4173", "s1", fetchFn)).toEqual(["a", "b"]);
  expect(calls[0]!.url).toBe("http://localhost:4173/action/inbox-drain");
  expect(calls[0]!.body).toEqual({ sessionId: "s1" });
});

test("drainInbox returns nothing when the dashboard is down or answers badly", async () => {
  const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await drainInbox("http://localhost:4173", "s1", down)).toEqual([]);
  const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  expect(await drainInbox("http://localhost:4173", "s1", bad)).toEqual([]);
});

// --- crew: the identity that outlives the session id ----------------------

test("SessionStart seeds the crew and shows its name instead of the hashed one", () => {
  const crew = { id: "ripley-3f2a", name: "RIPLEY" };
  const s = applyEvent(null, { ...start, branch: "main" } as any, 1000, undefined, crew)!;
  expect(s.crew).toEqual(crew);
  expect(s.name).toBe("RIPLEY");
});

test("a persona-matched branch still takes the crew name", () => {
  const s = applyEvent(null, start as any, 1000, undefined, { id: "kane-1", name: "KANE" })!;
  expect(s.name).toBe("KANE");
  expect(s.role).toBe("Component build");
});

test("no crew keeps the hashed roster name", () => {
  const s = applyEvent(null, { ...start, branch: "main" } as any, 1000)!;
  expect(s.crew).toBeUndefined();
  expect(s.name.length).toBeGreaterThan(0);
});

test("a later event re-stamps the crew onto a prev that lost it, never overwriting one", () => {
  const crew = { id: "ripley-3f2a", name: "RIPLEY" };
  const prev = applyEvent(null, start as any, 1000, undefined, crew)!;
  const stripped = { ...prev } as any;
  delete stripped.crew;
  const tool = { ...start, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" } };
  expect(applyEvent(stripped, tool as any, 2000, undefined, crew)!.crew).toEqual(crew);
  expect(applyEvent(prev, tool as any, 2000, undefined, { id: "other", name: "OTHER" })!.crew).toEqual(crew);
});

test("sessionStartOutput is a SessionStart additionalContext carrying the notes", async () => {
  const { sessionStartOutput } = await import("../hooks/status");
  const out = sessionStartOutput({ id: "ripley-3f2a", name: "RIPLEY" }, "tests live in tests/\n", "http://localhost:4173");
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("You are RIPLEY");
  expect(out.hookSpecificOutput.additionalContext).toContain("tests live in tests/");
});
