import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { buildLaunchInput, asStr, workerPermissionSettings, freshTaskInput, ALLOWED_PERMISSION_MODES } from "../src/ghostty";
import type { Persona } from "../src/lib/personas";

const P: Persona = {
  id: "frontend-ux", name: "PIXEL", role: "Frontend UX",
  sprite: { body: "engineer", palette: 2, gear: "" },
  skills: ["frontend-design"],
  prompt: "You are the frontend/UX developer.",
};

test("no persona keeps today's command shape", () => {
  expect(buildLaunchInput("do a thing", {}, null)).toBe("claude 'do a thing'\n");
});

test("auto is an allowed permission mode", () => {
  expect(buildLaunchInput("t", { permissionMode: "auto" }, null)).toBe("claude --permission-mode auto 't'\n");
});

test("the permission-mode allowlist matches the claude CLI's choices", () => {
  // `claude --help`: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.
  // dontAsk is left out on purpose: it denies anything not pre-approved, which
  // stalls an agent working a card. "default" is no longer a listed choice.
  expect([...ALLOWED_PERMISSION_MODES].sort()).toEqual(["acceptEdits", "auto", "bypassPermissions", "manual", "plan"]);
  expect(buildLaunchInput("t", { permissionMode: "manual" }, null)).toBe("claude --permission-mode manual 't'\n");
  expect(buildLaunchInput("t", { permissionMode: "default" }, null)).toBe("claude 't'\n");
});

test("the New Agent dialog only offers allowlisted modes", () => {
  const src = readFileSync(new URL("../src/ui/NewAgentModal.tsx", import.meta.url), "utf8");
  const select = src.slice(src.indexOf('id="na-perm"'), src.indexOf("</select>", src.indexOf('id="na-perm"')));
  const values = [...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter((v) => v !== "");
  expect(values.length).toBeGreaterThan(0);
  for (const v of values) expect(ALLOWED_PERMISSION_MODES.has(v)).toBe(true);
});

test("model and permission mode are allowlisted", () => {
  expect(buildLaunchInput("t", { model: "opus", permissionMode: "plan" }, null))
    .toBe("claude --model opus --permission-mode plan 't'\n");
  expect(buildLaunchInput("t", { model: "evil; rm -rf /", permissionMode: "nope" }, null))
    .toBe("claude 't'\n");
});

test("a persona adds the env var and the system prompt", () => {
  const out = buildLaunchInput("build the card", {}, P);
  expect(out.startsWith("AGENT_PERSONA=frontend-ux claude ")).toBe(true);
  // composePrompt opens with the identity line, then the persona's own body
  expect(out).toContain("--append-system-prompt 'You are PIXEL, the team'\\''s Frontend UX.");
  expect(out).toContain("You are the frontend/UX developer.");
  expect(out).toContain("frontend-design");
  expect(out.endsWith(" 'build the card'\n")).toBe(true);
});

test("single quotes in the task and prompt are escaped", () => {
  const out = buildLaunchInput("don't break", {}, { ...P, prompt: "it's fine" });
  expect(out).toContain(`'don'\\''t break'`);
  expect(out).toContain(`it'\\''s fine`);
});

test("a multi-line prompt is passed through intact", () => {
  const out = buildLaunchInput("t", {}, { ...P, prompt: "line one\nline two", skills: [] });
  expect(out).toContain("line one\nline two");
});

// ---- freshTaskInput: a new task starts from a cleared context -------------

test("freshTaskInput submits /clear before typing the task", () => {
  const body = freshTaskInput("do the thing");
  const clearAt = body.indexOf("/clear");
  const taskAt = body.indexOf("do the thing");
  expect(clearAt).toBeGreaterThanOrEqual(0);
  expect(taskAt).toBeGreaterThan(clearAt); // clear is submitted first
  // two separate submissions: the /clear, then the task
  expect(body.split('send key "enter"').length - 1).toBe(2);
});

test("freshTaskInput waits between the clear and the task", () => {
  // a delay must sit between the /clear submission and the task, so /clear has
  // finished resetting the context before the task is typed
  const body = freshTaskInput("t");
  const between = body.slice(body.indexOf("/clear"), body.lastIndexOf("input text"));
  expect(between).toContain("delay");
});

// ---- asStr: the AppleScript string literal --------------------------------
// osascript decodes its -e argument as Latin-1, so raw UTF-8 bytes for an em
// dash arrive as mojibake ("— THE LINE —" → "â\x80\x94 THE LINE â\x80\x94").
// Anything outside printable ASCII is emitted as `character id N` instead, which
// is encoding-independent.

test("asStr quotes plain ASCII as a literal", () => {
  expect(asStr("hello world")).toBe('("hello world")');
});

test("asStr escapes backslashes and quotes", () => {
  expect(asStr('a\\b"c')).toBe('("a\\\\b\\"c")');
});

test("asStr emits non-ASCII as character id, never raw bytes", () => {
  const s = asStr("— THE LINE —");
  expect(s).not.toContain("—");
  expect(s).toBe('((character id 8212) & " THE LINE " & (character id 8212))');
});

test("asStr escapes newlines and tabs, which can't sit in a literal", () => {
  expect(asStr("a\nb")).toBe('("a" & (character id 10) & "b")');
  expect(asStr("a\tb")).toBe('("a" & (character id 9) & "b")');
});

test("asStr emits an astral char as one code point, not a lone surrogate", () => {
  // AppleScript rejects `character id 55357` ("Can't get character id 55357"),
  // so 🔥 U+1F525 must go out as 128293, not its two UTF-16 units.
  expect(asStr("🔥")).toBe("((character id 128293))");
});

test("asStr handles the empty string", () => {
  expect(asStr("")).toBe('("")');
});

test("asStr round-trips a real card prompt's arrows", () => {
  const s = asStr("backlog → in-progress");
  expect(s).toContain("character id 8594");
  expect(s).not.toContain("→");
});

// ---- the workshop URL env + worker permission settings --------------------

test("serverUrl rides into the launch env so the agent can find the API", () => {
  const out = buildLaunchInput("t", { serverUrl: "http://localhost:4173" }, P);
  expect(out.startsWith("AGENT_PERSONA=frontend-ux AGENT_WORKSHOP_URL='http://localhost:4173' claude ")).toBe(true);
});

test("serverUrl is set even without a persona", () => {
  const out = buildLaunchInput("t", { serverUrl: "http://localhost:4173" }, null);
  expect(out.startsWith("AGENT_WORKSHOP_URL='http://localhost:4173' claude ")).toBe(true);
});

test("cardId rides into the launch env so the SessionStart hook can self-assign the card", () => {
  const out = buildLaunchInput("t", { serverUrl: "http://localhost:4173", cardId: "card_defabed5" }, P);
  expect(out.startsWith("AGENT_PERSONA=frontend-ux AGENT_WORKSHOP_URL='http://localhost:4173' AGENT_CARD='card_defabed5' claude ")).toBe(true);
});

test("no cardId means no AGENT_CARD in the env", () => {
  expect(buildLaunchInput("t", { serverUrl: "http://localhost:4173" }, null)).not.toContain("AGENT_CARD");
});

test("a cardId is shell-quoted so it can't inject into the launch command", () => {
  const out = buildLaunchInput("t", { cardId: "x'; rm -rf /" }, null);
  expect(out).toContain("AGENT_CARD='x'\\''; rm -rf /'");
});

test("workerPermissionSettings allows the board read, card writes, and local git", () => {
  const s = workerPermissionSettings("http://localhost:4173", "/Users/guy/github/agent-smith");
  expect(s.permissions.allow).toEqual([
    "Bash(curl -s http://localhost:4173/board)",
    "Bash(curl -s 'http://localhost:4173/card?id=:*)",
    "Bash(curl -s http://localhost:4173/agents)",
    "Bash(curl -s -X POST http://localhost:4173/action/card-move:*)",
    "Bash(curl -s -X POST http://localhost:4173/action/card-comment:*)",
    "Bash(curl -s -X POST http://localhost:4173/action/crew-note:*)",
    "mcp__the-line__board_read",
    "mcp__the-line__card_read",
    "mcp__the-line__agents_list",
    "mcp__the-line__card_move",
    "mcp__the-line__card_comment",
    "mcp__the-line__crew_note",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
  ]);
  // never the spawn/kill/prompt endpoints, the MCP tools that reach other
  // sessions, or git push — those stay behind a human approval
  expect(s.permissions.allow).not.toContain("mcp__the-line__card_send_task");
  expect(s.permissions.allow).not.toContain("mcp__the-line__card_assign");
  expect(JSON.stringify(s)).not.toContain("/action/spawn");
  expect(JSON.stringify(s)).not.toContain("git push");
});

test("workerPermissionSettings allows no git merge: merging stays human-only, through the merge queue", () => {
  const root = "/tmp/some repo/root";
  const allow = workerPermissionSettings("http://localhost:4173", root).permissions.allow;
  // no merge in any form: bare, or scoped by -C to the repo root
  expect(allow.some((r) => /\bmerge\b/.test(r))).toBe(false);
  expect(allow.some((r) => r.includes(root))).toBe(false);
  // and no other history-rewriting or remote verb
  for (const verb of ["push", "reset", "rebase", "checkout", "switch", "branch", "worktree"]) {
    expect(allow.some((r) => r.includes(`git ${verb}`) || r.includes(` ${verb}:`))).toBe(false);
  }
});

// --- crew: the name and id ride the env, and the prompt is addressed to it ---

test("a crew member rides into the env after the persona, and the prompt speaks to its name", () => {
  const out = buildLaunchInput("t", { crew: { id: "ripley-3f2a", name: "RIPLEY" } }, P);
  expect(out.startsWith("AGENT_PERSONA=frontend-ux AGENT_CREW='ripley-3f2a' AGENT_NAME='RIPLEY' claude ")).toBe(true);
  expect(out).toContain("You are RIPLEY, the team'\\''s Frontend UX.");
  expect(out).not.toContain("PIXEL");
});

test("a crew member without a persona still gets an identity prompt", () => {
  const out = buildLaunchInput("t", { crew: { id: "kane-0001", name: "KANE" } }, null);
  expect(out.startsWith("AGENT_CREW='kane-0001' AGENT_NAME='KANE' claude --append-system-prompt ")).toBe(true);
  expect(out).toContain("You are KANE, a member of this team.");
  expect(out).not.toContain("AGENT_PERSONA");
});

test("no crew means no crew env and no identity prompt", () => {
  const out = buildLaunchInput("t", {}, null);
  expect(out).not.toContain("AGENT_CREW");
  expect(out).not.toContain("--append-system-prompt");
});
