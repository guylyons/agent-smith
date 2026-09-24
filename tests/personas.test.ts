import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { parsePersona, loadPersonas, getPersona, composePrompt, composeIdentityPrompt, spawnName, PERSONA_ID_RE } from "../src/lib/personas";
import { ROSTER } from "../src/lib/crew";

const dir = fixtureDir("personas-test");
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
  expect(parsePersona(GOOD.replace("role: Frontend UX\n", ""), "frontend-ux")).toBeNull();
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
  expect(getPersona("backend-dev", dir)!.sprite?.body).toBe("robot");
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
  const out = composePrompt(p);
  expect(out).toContain("You are the frontend/UX developer.");
  expect(out).not.toContain("Skill tool");
});

test("composePrompt opens with the persona's codename and role", () => {
  const p = parsePersona(GOOD, "frontend-ux")!;
  expect(composePrompt(p).startsWith(`You are ${p.name}, the team's ${p.role}.`)).toBe(true);
});

// --- crew names: a persona is a role; the name belongs to whoever was spawned --

const NAMELESS = GOOD.replace("name: PIXEL\n", "");

test("a persona without a name parses; the name is the crew member's", () => {
  const p = parsePersona(NAMELESS, "frontend-ux")!;
  expect(p.name).toBeUndefined();
  expect(p.role).toBe("Frontend UX");
});

test("composePrompt addresses the crew name over the persona's own", () => {
  const p = parsePersona(GOOD, "frontend-ux")!;
  const out = composePrompt(p, "RIPLEY");
  expect(out.startsWith("You are RIPLEY, the team's Frontend UX.")).toBe(true);
  expect(out).toContain("the team board knows you as RIPLEY");
  expect(out).not.toContain("PIXEL");
});

test("composePrompt with neither name still opens with the role", () => {
  const p = parsePersona(NAMELESS, "frontend-ux")!;
  expect(composePrompt(p).startsWith("You are the team's Frontend UX.")).toBe(true);
});

test("composeIdentityPrompt names the agent and teaches the board protocol, in ASCII", () => {
  const out = composeIdentityPrompt("VASQUEZ");
  expect(out.startsWith("You are VASQUEZ, a member of this team.")).toBe(true);
  expect(out).toContain("the team board knows you as VASQUEZ");
  expect(out).toContain("-- THE LINE --");
  expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
});

test("a nameless persona sets role and sprite but leaves the name alone", () => {
  const personas = [parsePersona(NAMELESS, "frontend-ux")!];
  const [a] = applyPersonas([A({ persona: "frontend-ux" })], personas);
  expect(a.name).toBe("NOVA");
  expect(a.role).toBe("Frontend UX");
  expect(a.sprite).toEqual({ body: "engineer", palette: 2, gear: "" });
});

test("each shipped persona has its own roster name and a fixed look", () => {
  const shipped = loadPersonas();
  for (const p of shipped) {
    expect(ROSTER).toContain(p.name!);
    expect(p.sprite).toBeDefined();
  }
  expect(new Set(shipped.map((p) => p.name)).size).toBe(shipped.length);
  expect(new Set(shipped.map((p) => p.sprite!.body)).size).toBe(shipped.length);
});

test("editor and release manager launch on sonnet", () => {
  expect(getPersona("editor")!.model).toBe("sonnet");
  expect(getPersona("release-manager")!.model).toBe("sonnet");
});

test("a persona's model must be one the launcher allows", () => {
  expect(parsePersona(GOOD.replace("skills:", "model: sonnet\nskills:"), "frontend-ux")!.model).toBe("sonnet");
  expect(parsePersona(GOOD, "frontend-ux")!.model).toBeUndefined();
  expect(parsePersona(GOOD.replace("skills:", "model: gpt\nskills:"), "frontend-ux")).toBeNull();
});

test("a persona name is normalized to uppercase and must be a single word", () => {
  expect(parsePersona(GOOD.replace("name: PIXEL", "name: Pixel"), "frontend-ux")!.name).toBe("PIXEL");
  expect(parsePersona(GOOD.replace("name: PIXEL", "name: Pix El"), "frontend-ux")).toBeNull();
});

test("spawnName gives a persona its own name, suffixed when a copy is live", () => {
  const personas = [parsePersona(GOOD, "frontend-ux")!, parsePersona(NAMELESS.replace("id: frontend-ux", "id: plain"), "plain")!];
  expect(spawnName("frontend-ux", personas, [])).toBe("PIXEL");
  expect(spawnName("frontend-ux", personas, ["PIXEL"])).toBe("PIXEL-2");
  expect(spawnName("frontend-ux", personas, ["pixel", "PIXEL-2"])).toBe("PIXEL-3");
});

test("spawnName never hands a persona's name to anyone else", () => {
  const personas = loadPersonas();
  const owned = new Set(personas.map((p) => p.name));
  for (let i = 0; i < 200; i++) {
    const n = spawnName(undefined, personas, [], () => i / 200);
    expect(owned.has(n)).toBe(false);
    expect(ROSTER).toContain(n);
  }
  // a nameless persona draws from the same pool
  const withNameless = [...personas, parsePersona(NAMELESS.replace("id: frontend-ux", "id: plain"), "plain")!];
  for (let i = 0; i < 200; i++) expect(owned.has(spawnName("plain", withNameless, [], () => i / 200))).toBe(false);
});

test("composePrompt teaches the board protocol to every persona", () => {
  const p = parsePersona(GOOD, "frontend-ux")!;
  const out = composePrompt(p);
  expect(out).toContain("-- THE LINE --");
  expect(out).toContain("[THE LINE]");
  expect(out).toContain(`the team board knows you as ${p.name}`);
  expect(out).toContain("AGENT_WORKSHOP_URL");
});

test("composePrompt tells every persona to write board comments plainly", () => {
  const p = parsePersona(GOOD, "frontend-ux")!;
  const out = composePrompt(p).toLowerCase();
  expect(out).toContain("plainly");
});

test("composePrompt's generated lines are pure ASCII", () => {
  const p = parsePersona(GOOD, "frontend-ux")!;
  // strip the author-written body; everything the code generates must be ASCII
  const generated = composePrompt(p).replaceAll(p.prompt, "");
  expect(/^[\x00-\x7f]*$/.test(generated)).toBe(true);
});

test("the shipped built-in personas all load", () => {
  const ids = loadPersonas().map((p) => p.id);
  expect(ids).toEqual(["backend-dev", "editor", "frontend-ux", "release-manager", "scrum-master"]);
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

test("PERSONA_ID_RE does not drift between src/lib/personas.ts and hooks/status.ts", () => {
  // Guard against silent divergence of the deliberately-duplicated regex.
  // The hook keeps its own copy to avoid loading the registry on every tool use.
  // If the two copies diverge, personas silently drop without error.
  const hookPath = join(import.meta.dir, "../hooks/status.ts");
  const hookContent = readFileSync(hookPath, "utf8");

  // Extract the regex literal from: const PERSONA_ID_RE = /^[a-z0-9-]{1,64}$/;
  const match = hookContent.match(/const\s+PERSONA_ID_RE\s*=\s*(\/.+?\/)\s*;/);
  expect(match, `Failed to extract PERSONA_ID_RE from ${hookPath}`).toBeTruthy();

  const hookRegexLiteral = match![1];
  const registryRegexLiteral = `/${PERSONA_ID_RE.source}/`;

  expect(hookRegexLiteral,
    `Regex drift detected:\n  hooks/status.ts: ${hookRegexLiteral}\n  src/lib/personas.ts: ${registryRegexLiteral}`
  ).toBe(registryRegexLiteral);

  // Also ensure no flags were accidentally added on either side.
  expect(PERSONA_ID_RE.flags).toBe("");
});

test("composePrompt tells every persona when a board notification wants a reply and when it does not", () => {
  const p = parsePersona("---\nid: x\nname: X\nrole: R\nsprite: { body: worker, palette: 0 }\n---\nBody.", "x")!;
  const out = composePrompt(p);
  expect(out).toContain("reply expected");
  expect(out).toContain("no reply needed");
  expect(out).not.toContain("respond on that card via card-comment rather than");
  expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
});

test("a persona without a sprite is valid and leaves the desk's sprite alone", () => {
  const p = parsePersona("---\nid: x\nrole: R\n---\nBody.", "x")!;
  expect(p).not.toBeNull();
  expect(p.sprite).toBeUndefined();
  const input = [A({ persona: "x", sprite: { palette: 1, gear: "hood", body: "cat" } })];
  const [a] = applyPersonas(input, [p]);
  expect(a.role).toBe("R");
  expect(a.sprite).toEqual({ palette: 1, gear: "hood", body: "cat" });
  const [bare] = applyPersonas([A({ persona: "x" })], [p]);
  expect(bare.sprite).toBeUndefined();
});

// loadPersonas runs on every snapshot, so it caches: the directory listing by
// the dir's mtime, each file's parse by that file's mtime + size. These tests
// pin mtimes with utimes so "unchanged" is exact, then change content behind
// the cache's back to prove what was (and wasn't) re-read.
const T1 = new Date("2020-01-01T00:00:00Z");
const T2 = new Date("2020-01-02T00:00:00Z");
const pin = (path: string, t: Date) => utimesSync(path, t, t);

test("loadPersonas does not re-read a persona file whose mtime is unchanged", () => {
  reset();
  const file = join(dir, "frontend-ux.md");
  write("frontend-ux", GOOD);
  pin(file, T1); pin(dir, T1);
  expect(loadPersonas(dir)[0].name).toBe("PIXEL");
  write("frontend-ux", GOOD.replace("PIXEL", "PIXIE")); // same size
  pin(file, T1); pin(dir, T1);
  expect(loadPersonas(dir)[0].name).toBe("PIXEL"); // served from cache
});

test("loadPersonas picks up an in-place edit even when the dir mtime is unchanged", () => {
  reset();
  const file = join(dir, "frontend-ux.md");
  write("frontend-ux", GOOD);
  pin(file, T1); pin(dir, T1);
  expect(loadPersonas(dir)[0].name).toBe("PIXEL");
  write("frontend-ux", GOOD.replace("PIXEL", "PIXIE"));
  pin(file, T2); pin(dir, T1); // editors that write in place leave the dir alone
  expect(loadPersonas(dir)[0].name).toBe("PIXIE");
});

test("loadPersonas re-lists the directory only when its mtime changes", () => {
  reset();
  write("frontend-ux", GOOD);
  pin(join(dir, "frontend-ux.md"), T1); pin(dir, T1);
  expect(loadPersonas(dir).map((p) => p.id)).toEqual(["frontend-ux"]);
  write("backend-dev", GOOD.replace("id: frontend-ux", "id: backend-dev"));
  pin(dir, T1); // listing unchanged as far as the cache can tell
  expect(loadPersonas(dir).map((p) => p.id)).toEqual(["frontend-ux"]);
  pin(dir, T2);
  expect(loadPersonas(dir).map((p) => p.id)).toEqual(["backend-dev", "frontend-ux"]);
});

test("loadPersonas drops a deleted persona once the dir mtime moves", () => {
  reset();
  write("frontend-ux", GOOD);
  write("backend-dev", GOOD.replace("id: frontend-ux", "id: backend-dev"));
  pin(dir, T1);
  expect(loadPersonas(dir)).toHaveLength(2);
  rmSync(join(dir, "backend-dev.md"));
  pin(dir, T2);
  expect(loadPersonas(dir).map((p) => p.id)).toEqual(["frontend-ux"]);
});

test("loadPersonas hands out a fresh array, so a caller can't corrupt the cache", () => {
  reset();
  write("frontend-ux", GOOD);
  const first = loadPersonas(dir);
  first.length = 0;
  expect(loadPersonas(dir)).toHaveLength(1);
});

test("loadPersonas returns [] for a missing dir and recovers when it appears", () => {
  const missing = join(dir, "..", "personas-test-missing");
  rmSync(missing, { recursive: true, force: true });
  expect(loadPersonas(missing)).toEqual([]);
  mkdirSync(missing, { recursive: true });
  writeFileSync(join(missing, "frontend-ux.md"), GOOD);
  expect(loadPersonas(missing).map((p) => p.id)).toEqual(["frontend-ux"]);
  rmSync(missing, { recursive: true, force: true });
});
