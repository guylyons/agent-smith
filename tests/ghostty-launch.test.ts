import { test, expect } from "bun:test";
import { buildLaunchInput, asStr } from "../src/ghostty";
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
  expect(out).toContain("--append-system-prompt 'You are the frontend/UX developer.");
  expect(out).toContain("frontend-design");
  expect(out.endsWith(" 'build the card'\n")).toBe(true);
});

test("single quotes in the task and prompt are escaped", () => {
  const out = buildLaunchInput("don't break", {}, { ...P, prompt: "it's fine" });
  expect(out).toContain(`'don'\\''t break'`);
  expect(out).toContain(`'it'\\''s fine`);
});

test("a multi-line prompt is passed through intact", () => {
  const out = buildLaunchInput("t", {}, { ...P, prompt: "line one\nline two", skills: [] });
  expect(out).toContain("--append-system-prompt 'line one\nline two'");
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
