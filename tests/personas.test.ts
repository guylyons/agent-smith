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
