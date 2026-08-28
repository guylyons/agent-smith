import { test, expect } from "bun:test";
import { buildLaunchInput, asStr, workerPermissionSettings } from "../src/ghostty";
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

test("workerPermissionSettings allows the board read, card writes, and local git", () => {
  const s = workerPermissionSettings("http://localhost:4173");
  expect(s.permissions.allow).toEqual([
    "Bash(curl -s http://localhost:4173/board)",
    "Bash(curl -s http://localhost:4173/agents)",
    "Bash(curl -s -X POST http://localhost:4173/action/card-move:*)",
    "Bash(curl -s -X POST http://localhost:4173/action/card-comment:*)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
  ]);
  // never the spawn/kill/prompt endpoints or git push — those stay behind a
  // human approval
  expect(JSON.stringify(s)).not.toContain("/action/spawn");
  expect(JSON.stringify(s)).not.toContain("git push");
});
