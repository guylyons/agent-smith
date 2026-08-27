import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePersona, loadPersonas, getPersona, composePrompt } from "../src/lib/personas";

const dir = "/tmp/aw-personas-test";
function reset() { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
function write(stem: string, body: string) { writeFileSync(join(dir, `${stem}.md`), body); }

const GOOD = `---
id: frontend-ux
name: PIXEL
role: Frontend UX
sprite: { body: engineer, palette: 2 }
skills: [frontend-design, brainstorming]
---
You are the frontend/UX developer.`;

test("parses a valid persona and defaults gear to empty", () => {
  const p = parsePersona(GOOD, "frontend-ux")!;
  expect(p.id).toBe("frontend-ux");
  expect(p.name).toBe("PIXEL");
  expect(p.role).toBe("Frontend UX");
  expect(p.sprite).toEqual({ body: "engineer", palette: 2, gear: "" });
  expect(p.skills).toEqual(["frontend-design", "brainstorming"]);
  expect(p.prompt).toBe("You are the frontend/UX developer.");
});

test("rejects malformed and invalid personas", () => {
  expect(parsePersona("no frontmatter here", "x")).toBeNull();
  expect(parsePersona("---\na: [unclosed\n---\nbody", "x")).toBeNull();
  expect(parsePersona(GOOD, "different-stem")).toBeNull();
  expect(parsePersona(GOOD.replace("palette: 2", "palette: 9"), "frontend-ux")).toBeNull();
  expect(parsePersona(GOOD.replace("body: engineer", "body: dragon"), "frontend-ux")).toBeNull();
  expect(parsePersona(GOOD.replace("name: PIXEL\n", ""), "frontend-ux")).toBeNull();
  expect(parsePersona(GOOD.replace("You are the frontend/UX developer.", ""), "frontend-ux")).toBeNull();
});

test("a bad file is skipped, not fatal", () => {
  reset();
  write("frontend-ux", GOOD);
  write("broken", "---\nnope\n---\n");
  const all = loadPersonas(dir);
  expect(all.map((p) => p.id)).toEqual(["frontend-ux"]);
});

test("loadPersonas sorts by id and getPersona finds by id", () => {
  reset();
  write("frontend-ux", GOOD);
  write("backend-dev", GOOD.replace("id: frontend-ux", "id: backend-dev").replace("body: engineer", "body: robot"));
  expect(loadPersonas(dir).map((p) => p.id)).toEqual(["backend-dev", "frontend-ux"]);
  expect(getPersona("backend-dev", dir)!.sprite.body).toBe("robot");
  expect(getPersona("nope", dir)).toBeNull();
});

test("composePrompt keeps the body and names the skills", () => {
  const p = parsePersona(GOOD, "frontend-ux")!;
  const out = composePrompt(p);
  expect(out).toContain("You are the frontend/UX developer.");
  expect(out).toContain("frontend-design");
  expect(out).toContain("brainstorming");
  expect(out).toContain("Skill tool");
});

test("composePrompt omits the skills line when there are no skills", () => {
  const p = parsePersona(GOOD.replace("skills: [frontend-design, brainstorming]", "skills: []"), "frontend-ux")!;
  expect(composePrompt(p)).toBe("You are the frontend/UX developer.");
});

test("the shipped built-in personas all load", () => {
  const ids = loadPersonas().map((p) => p.id);
  expect(ids).toEqual(["backend-dev", "editor", "frontend-ux", "scrum-master"]);
});

import { applyPersonas } from "../src/lib/personas";
import { parseStatus, type AgentStatus } from "../src/schema";
import { applyOverrides } from "../src/lib/overrides";

const A = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "NOVA", role: "General", ticket: null, state: "idle",
  doing: "x", cwd: "/repo", branch: null, updatedAt: 0, ...o,
});

test("a persona replaces name, role and sprite", () => {
  const personas = [parsePersona(GOOD, "frontend-ux")!];
  const [a] = applyPersonas([A({ persona: "frontend-ux" })], personas);
  expect(a.name).toBe("PIXEL");
  expect(a.role).toBe("Frontend UX");
  expect(a.sprite).toEqual({ body: "engineer", palette: 2, gear: "" });
});

test("agents without a persona, or with an unknown one, pass through untouched", () => {
  const personas = [parsePersona(GOOD, "frontend-ux")!];
  const input = [A({ sessionId: "a" }), A({ sessionId: "b", persona: "ghost" })];
  expect(applyPersonas(input, personas)).toEqual(input);
});

test("applyPersonas never mutates its input", () => {
  const personas = [parsePersona(GOOD, "frontend-ux")!];
  const input = [A({ persona: "frontend-ux" })];
  applyPersonas(input, personas);
  expect(input[0].name).toBe("NOVA");
});

test("a user override beats the persona", () => {
  const personas = [parsePersona(GOOD, "frontend-ux")!];
  const agents = [A({ sessionId: "s1", persona: "frontend-ux" })];
  const out = applyOverrides(applyPersonas(agents, personas), { s1: { name: "Captain" } });
  expect(out[0].name).toBe("Captain");     // override wins
  expect(out[0].role).toBe("Frontend UX"); // persona still supplies the rest
});

test("persona survives a schema round-trip and is optional", () => {
  expect(parseStatus({ ...A({ persona: "frontend-ux" }) })!.persona).toBe("frontend-ux");
  expect(parseStatus({ ...A({}) })!.persona).toBeUndefined();
});
