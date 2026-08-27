import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPathTrusted,
  withTrust,
  detectIndent,
  registerWorktreeTrust,
  type ClaudeConfig,
} from "../src/lib/trust";

function tmpConfig(config: ClaudeConfig, indent: string | number = 2): string {
  const dir = mkdtempSync(join(tmpdir(), "trust-"));
  const file = join(dir, ".claude.json");
  writeFileSync(file, JSON.stringify(config, null, indent) + "\n");
  return file;
}

const ROOT = "/repo";
const WT = "/repo/.claude/worktrees/feature";

// ---- isPathTrusted ---------------------------------------------------------

test("isPathTrusted is true only when hasTrustDialogAccepted is true", () => {
  const c: ClaudeConfig = { projects: { [ROOT]: { hasTrustDialogAccepted: true } } };
  expect(isPathTrusted(c, ROOT)).toBe(true);
});

test("isPathTrusted is false when the entry says false", () => {
  const c: ClaudeConfig = { projects: { [ROOT]: { hasTrustDialogAccepted: false } } };
  expect(isPathTrusted(c, ROOT)).toBe(false);
});

test("isPathTrusted is false for an unknown path", () => {
  const c: ClaudeConfig = { projects: { [ROOT]: { hasTrustDialogAccepted: true } } };
  expect(isPathTrusted(c, WT)).toBe(false);
});

test("isPathTrusted is false when there is no projects map", () => {
  expect(isPathTrusted({}, ROOT)).toBe(false);
});

// ---- withTrust -------------------------------------------------------------

test("withTrust marks a new path trusted and creates the projects map", () => {
  const next = withTrust({}, WT);
  expect(next.projects?.[WT]?.hasTrustDialogAccepted).toBe(true);
});

test("withTrust preserves an existing entry's other keys", () => {
  const c: ClaudeConfig = { projects: { [WT]: { allowedTools: ["Read"], hasTrustDialogAccepted: false } } };
  const next = withTrust(c, WT);
  expect(next.projects?.[WT]).toEqual({ allowedTools: ["Read"], hasTrustDialogAccepted: true });
});

test("withTrust preserves other projects and top-level keys", () => {
  const c: ClaudeConfig = { numStartups: 5, projects: { [ROOT]: { hasTrustDialogAccepted: true } } };
  const next = withTrust(c, WT);
  expect(next.numStartups).toBe(5);
  expect(next.projects?.[ROOT]?.hasTrustDialogAccepted).toBe(true);
  expect(next.projects?.[WT]?.hasTrustDialogAccepted).toBe(true);
});

test("withTrust does not mutate its input", () => {
  const c: ClaudeConfig = { projects: { [ROOT]: { hasTrustDialogAccepted: true } } };
  withTrust(c, WT);
  expect(c.projects?.[WT]).toBeUndefined();
});

// ---- detectIndent ----------------------------------------------------------

test("detectIndent reads a two-space pretty file", () => {
  expect(detectIndent('{\n  "a": 1\n}')).toBe("  ");
});

test("detectIndent returns 0 for a minified file", () => {
  expect(detectIndent('{"a":1}')).toBe(0);
});

// ---- registerWorktreeTrust: the gate --------------------------------------

test("registerWorktreeTrust does nothing when the repo root is not trusted", () => {
  const file = tmpConfig({ projects: { [ROOT]: { hasTrustDialogAccepted: false } } });
  const before = readFileSync(file, "utf8");
  const r = registerWorktreeTrust(ROOT, WT, file);
  expect(r).toEqual({ ok: true, trusted: false });
  expect(readFileSync(file, "utf8")).toBe(before); // untouched
});

test("registerWorktreeTrust trusts the worktree when the repo root is trusted", () => {
  const file = tmpConfig({ projects: { [ROOT]: { hasTrustDialogAccepted: true } } });
  const r = registerWorktreeTrust(ROOT, WT, file);
  expect(r).toEqual({ ok: true, trusted: true });
  const written = JSON.parse(readFileSync(file, "utf8")) as ClaudeConfig;
  expect(written.projects?.[WT]?.hasTrustDialogAccepted).toBe(true);
});

test("registerWorktreeTrust preserves the rest of the config", () => {
  const file = tmpConfig({ numStartups: 9, projects: { [ROOT]: { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } } });
  registerWorktreeTrust(ROOT, WT, file);
  const written = JSON.parse(readFileSync(file, "utf8")) as ClaudeConfig;
  expect(written.numStartups).toBe(9);
  expect(written.projects?.[ROOT]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ["Bash"] });
});

test("registerWorktreeTrust preserves two-space indentation", () => {
  const file = tmpConfig({ projects: { [ROOT]: { hasTrustDialogAccepted: true } } }, 2);
  registerWorktreeTrust(ROOT, WT, file);
  expect(readFileSync(file, "utf8")).toContain('\n  "projects"');
});

test("registerWorktreeTrust is a no-op when the worktree is already trusted", () => {
  const file = tmpConfig({ projects: { [ROOT]: { hasTrustDialogAccepted: true }, [WT]: { hasTrustDialogAccepted: true } } });
  const before = readFileSync(file, "utf8");
  const r = registerWorktreeTrust(ROOT, WT, file);
  expect(r).toEqual({ ok: true, trusted: true });
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("registerWorktreeTrust returns an error (never throws) when the file is missing", () => {
  const r = registerWorktreeTrust(ROOT, WT, join(tmpdir(), "does-not-exist-aw", ".claude.json"));
  expect(r.ok).toBe(false);
  expect(r.trusted).toBe(false);
  expect(r.error).toBeTruthy();
});
