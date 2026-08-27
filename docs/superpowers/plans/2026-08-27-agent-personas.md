# Agent Personas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a launched agent be given a persona — Scrum Master, Editor, Backend Dev, Frontend UX — that shapes its system prompt and paints its desk.

**Architecture:** Persona definitions are markdown files with YAML frontmatter in `personas/`. The launch command carries the persona's prompt via `--append-system-prompt` and its id via an `AGENT_PERSONA` env var. The hook inherits that env var and writes the id onto the session's status file; the server resolves id → name/role/sprite at snapshot time, before user overrides are applied.

**Tech Stack:** Bun · TypeScript · React 19 · zod 4 · `Bun.YAML` · AppleScript (Ghostty)

**Spec:** `docs/superpowers/specs/2026-08-27-agent-personas-design.md`

## Global Constraints

- **No new dependencies.** YAML parses with the built-in `Bun.YAML`; validation uses the existing `zod` v4.
- **Malformed input is skipped, never fatal.** A bad persona file must not empty the picker or crash a snapshot — same posture as `parseStatus` and `readLineState`.
- **Pure logic stays pure.** `applyEvent`, `applyPersonas`, and `buildLaunchInput` take their inputs as parameters and touch no globals, so they are unit-testable. Env and filesystem reads live in the I/O glue.
- **Precedence is fixed:** user override > persona > `inferRole` > hashed codename. `applyPersonas` runs *inside* `applyOverrides` at the call site so overrides win.
- **Persona ids** match `/^[a-z0-9-]{1,64}$/` and must equal their filename stem.
- **Palette index** is `0..4` (`PALETTES.length` is 5). **Body** must be a key of `BODIES` in `src/ui/sprite-data.ts`.
- **Allowlist, don't sanitize.** An unknown persona id is dropped, never interpolated into a shell command — the rule `ALLOWED_MODELS` already follows.
- **`bun run build`** after any change under `src/ui`, or `dist/` goes stale. `dist/` is not tracked.

### Verified facts (do not re-litigate)

| Fact | Consequence |
| --- | --- |
| `--append-system-prompt` exists; `--append-system-prompt-file` does **not** | The prompt goes on the command line. |
| AppleScript string literals accept raw newlines | Multi-line prompts pass through `asStr` unchanged — no escaping work. |
| `Bun.YAML.parse` handles inline flow maps and throws on malformed input | Frontmatter parsing needs only a try/catch. |
| Hooks are spawned by the `claude` process | They inherit `AGENT_PERSONA`. |
| `src/ui/sprite-data.ts` has **zero imports** | `src/lib/` may import `BODIES`/`PALETTES` without pulling in React. |

---

## File Structure

| File | Responsibility |
| --- | --- |
| `personas/*.md` | The four built-in persona definitions (data). |
| `src/lib/personas.ts` | Parse, validate, and load personas; compose the system prompt; resolve personas onto agents. |
| `src/schema.ts` | Add the optional `persona` field to the status contract. |
| `hooks/status.ts` | Capture `AGENT_PERSONA` and carry it across events. |
| `src/ghostty.ts` | Compose the launch command with the persona prompt and env var. |
| `src/server.ts` | Serve `GET /personas`, accept `persona` on spawn, resolve personas into the snapshot. |
| `src/ui/actions.ts` | Fetch the persona list; forward `persona` on spawn. |
| `src/ui/NewAgentModal.tsx` | The PERSONA select. |
| `src/ui/ConversationDrawer.tsx` | The persona line in the INFO tab. |

---

### Task 1: Persona registry

**Files:**
- Create: `personas/scrum-master.md`, `personas/editor.md`, `personas/backend-dev.md`, `personas/frontend-ux.md`
- Create: `src/lib/personas.ts`
- Test: `tests/personas.test.ts`

**Interfaces:**
- Consumes: `BODIES`, `PALETTES` from `src/ui/sprite-data.ts`
- Produces:
  - `type Persona = { id: string; name: string; role: string; sprite: { body: string; palette: number; gear: string }; skills: string[]; prompt: string }`
  - `parsePersona(text: string, stem: string): Persona | null`
  - `loadPersonas(dir?: string): Persona[]` — sorted by `id`
  - `getPersona(id: string, dir?: string): Persona | null`
  - `composePrompt(p: Persona): string`

- [ ] **Step 1: Write the failing test**

Create `tests/personas.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/personas.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/personas'`

- [ ] **Step 3: Write the registry**

Create `src/lib/personas.ts`:

```ts
// Persona definitions: who an agent is when you launch it. Each `personas/*.md`
// file carries YAML frontmatter (identity + look + the skills it should reach
// for) and a prompt body appended to the session's system prompt at launch.
// A malformed file is skipped, never fatal — one bad persona must not empty the
// picker or crash a snapshot.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BODIES, PALETTES } from "../ui/sprite-data";

export const PERSONA_ID_RE = /^[a-z0-9-]{1,64}$/;

const PersonaMetaSchema = z.object({
  id: z.string().regex(PERSONA_ID_RE),
  name: z.string().min(1),
  role: z.string().min(1),
  sprite: z.object({
    body: z.string().min(1),
    palette: z.number().int().min(0).max(PALETTES.length - 1),
    // Gear overlays are only positioned for the `worker` body; every other body
    // ignores it, so an omitted gear is the empty string rather than an error.
    gear: z.string().default(""),
  }),
  skills: z.array(z.string().min(1)).default([]),
});

export type Persona = z.infer<typeof PersonaMetaSchema> & { prompt: string };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** The directory the built-in personas ship in (repo root / personas). */
export const PERSONAS_DIR = join(import.meta.dir, "..", "..", "personas");

/** Parse one persona file. `stem` is the filename without `.md`; a file whose
 *  `id` disagrees with its own name is rejected rather than silently renamed. */
export function parsePersona(text: string, stem: string): Persona | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  let meta: unknown;
  try { meta = Bun.YAML.parse(m[1]); } catch { return null; }
  const r = PersonaMetaSchema.safeParse(meta);
  if (!r.success) return null;
  if (r.data.id !== stem) return null;
  if (!(r.data.sprite.body in BODIES)) return null;
  const prompt = m[2].trim();
  if (!prompt) return null;
  return { ...r.data, prompt };
}

/** Every valid persona in `dir`, sorted by id. Re-read on each call so editing a
 *  persona file takes effect without restarting the server. */
export function loadPersonas(dir: string = PERSONAS_DIR): Persona[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; }
  const out: Persona[] = [];
  for (const f of names) {
    try {
      const p = parsePersona(readFileSync(join(dir, f), "utf8"), f.slice(0, -3));
      if (p) out.push(p);
    } catch { /* unreadable file; skip */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getPersona(id: string, dir: string = PERSONAS_DIR): Persona | null {
  if (!PERSONA_ID_RE.test(id)) return null;
  return loadPersonas(dir).find((p) => p.id === id) ?? null;
}

/** The text appended to the session's system prompt: the persona's own body plus
 *  a generated line naming its skills, so `skills:` stays declarative data rather
 *  than prose each author has to remember to write twice.
 *  Claude Code skills are model-invoked — naming them is the strongest lever a
 *  persona has; it cannot force them to load. */
export function composePrompt(p: Persona): string {
  if (p.skills.length === 0) return p.prompt;
  const list = p.skills.map((s) => `\`${s}\``).join(", ");
  return `${p.prompt}\n\nReach for ${list} via the Skill tool when the work calls for it.`;
}
```

- [ ] **Step 4: Write the four built-in personas**

Create `personas/scrum-master.md`:

```markdown
---
id: scrum-master
name: CADENCE
role: Scrum Master
sprite: { body: worker, palette: 0, gear: headset }
skills: [task-review, superpowers:writing-plans]
---
You are the scrum master on this team. Your job is to make work legible and
correctly sized before anyone starts building it.

Given a ticket, task, or vague request: clarify what it actually covers, surface
gaps and ambiguities, name which modules and files it touches, and lay out what
must be tested and where. Split anything that hides more than one deliverable.
Call out unstated dependencies and the order work has to happen in.

You do not implement. If asked to write code, say so and hand back a plan
instead.
```

Create `personas/editor.md`:

```markdown
---
id: editor
name: QUILL
role: Editor
sprite: { body: owl, palette: 3 }
skills: [superpowers:requesting-code-review]
---
You are the editor on this team. You work on prose — READMEs, docs, changelogs,
comments, commit messages, UI copy.

Cut what does not earn its place. Prefer the concrete word to the abstract one
and the short sentence to the long one. Keep the author's voice; you are editing
their writing, not replacing it with yours. Fix the structure before the
wording — a well-ordered paragraph of plain sentences beats a polished one that
argues in the wrong order.

Preserve technical accuracy exactly. If tightening a sentence would change what
it claims, leave it and flag it instead.
```

Create `personas/backend-dev.md`:

```markdown
---
id: backend-dev
name: ANVIL
role: Backend Dev
sprite: { body: robot, palette: 1 }
skills: [superpowers:test-driven-development, superpowers:systematic-debugging]
---
You are the backend developer on this team. You own data, state, and the
correctness of what happens on the server.

Work test-first: write the failing test, watch it fail, then make it pass. Think
in terms of the contract a module exposes and the invariants it must hold. Be
explicit about what happens on the unhappy path — malformed input, a missing
file, a partial write, two writers racing. Validate at the boundary and let bad
input be skipped rather than crash the caller.

Prefer pure functions that take their inputs as parameters; keep filesystem,
network, and environment reads in a thin I/O layer around them. That is what
makes the logic testable.
```

Create `personas/frontend-ux.md`:

```markdown
---
id: frontend-ux
name: PIXEL
role: Frontend UX
sprite: { body: engineer, palette: 2 }
skills: [superpowers:brainstorming]
---
You are the frontend/UX developer on this team. You own what the user actually
sees and touches.

Match the surrounding code's patterns and the existing visual language rather
than introducing a new one. Check the real rendered result — open the page and
inspect it; do not infer browser behavior from source. Handle the states people
forget: loading, empty, error, too-long text, and the narrow viewport.

Keep it keyboard-reachable and respect `prefers-reduced-motion`. When a change
is visual, say what you verified and where you verified it.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/personas.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add personas src/lib/personas.ts tests/personas.test.ts
git commit -m "feat: persona registry and the four built-in personas"
```

---

### Task 2: Status field and persona resolution

**Files:**
- Modify: `src/schema.ts` (add `persona` to `AgentStatusSchema`)
- Modify: `src/lib/personas.ts` (append `applyPersonas`)
- Test: `tests/personas.test.ts` (append)

**Interfaces:**
- Consumes: `Persona`, `loadPersonas` (Task 1); `AgentStatus` from `src/schema`
- Produces: `applyPersonas(agents: AgentStatus[], personas: Persona[]): AgentStatus[]`

- [ ] **Step 1: Write the failing test**

Append to `tests/personas.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/personas.test.ts`
Expected: FAIL — `applyPersonas is not a function`, plus a type error on `persona`

- [ ] **Step 3: Add the schema field**

In `src/schema.ts`, inside `AgentStatusSchema`, directly after the `subagents` field:

```ts
  // persona id (see personas/*.md), captured by the hook from AGENT_PERSONA at
  // launch. Only the id is stored — name/role/sprite resolve from the registry
  // at snapshot time, so editing a persona file updates live desks.
  persona: z.string().optional(),
```

- [ ] **Step 4: Add `applyPersonas`**

Append to `src/lib/personas.ts`:

```ts
import type { AgentStatus } from "../schema";

/** Fill name/role/sprite from each agent's persona. Mirrors `applyOverrides` in
 *  overrides.ts: pure, never mutates its inputs. Call it INSIDE applyOverrides —
 *  overrides are applied last so a name you typed yourself always wins. */
export function applyPersonas(agents: AgentStatus[], personas: Persona[]): AgentStatus[] {
  if (personas.length === 0) return agents;
  const byId = new Map(personas.map((p) => [p.id, p]));
  return agents.map((a) => {
    const p = a.persona ? byId.get(a.persona) : undefined;
    return p ? { ...a, name: p.name, role: p.role, sprite: { ...p.sprite } } : a;
  });
}
```

Move the `import type { AgentStatus }` line up with the other imports at the top of the file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/personas.test.ts tests/schema.test.ts tests/overrides.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/schema.ts src/lib/personas.ts tests/personas.test.ts
git commit -m "feat: resolve personas onto agents, under user overrides"
```

---

### Task 3: The hook captures `AGENT_PERSONA`

**Files:**
- Modify: `hooks/status.ts` (`seed`, `applyEvent`, `main`)
- Test: `tests/hook-status.test.ts` (append)

**Interfaces:**
- Consumes: nothing. The hook deliberately does **not** import `src/lib/personas` — the spec keeps it dumb, and the registry would drag `sprite-data` into a process that runs on every single tool use.
- Produces: `applyEvent(prev, e, now, persona?: string)` — a 4th optional parameter; existing 3-argument callers are unaffected.

- [ ] **Step 1: Write the failing test**

Append to `tests/hook-status.test.ts`:

```ts
test("SessionStart records a persona from the env", () => {
  const s = applyEvent(null, start as any, 1000, "frontend-ux")!;
  expect(s.persona).toBe("frontend-ux");
});

test("no persona when the env var is absent", () => {
  expect(applyEvent(null, start as any, 1000).persona).toBeUndefined();
  expect(applyEvent(null, start as any, 1000, "").persona).toBeUndefined();
});

test("an invalid persona id is dropped", () => {
  expect(applyEvent(null, start as any, 1000, "Bad Id!").persona).toBeUndefined();
  expect(applyEvent(null, start as any, 1000, "../escape").persona).toBeUndefined();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hook-status.test.ts`
Expected: FAIL — `Expected: "frontend-ux", Received: undefined`

- [ ] **Step 3: Thread the persona through the hook**

In `hooks/status.ts`, add this constant beside the other top-level declarations
(do **not** import it from `src/lib/personas` — this hook runs on every tool use
and must not pull the registry, and `sprite-data` behind it, into that path):

```ts
// Mirrors PERSONA_ID_RE in src/lib/personas.ts. Duplicated deliberately: the
// hook stores the id and nothing else, so it never loads the registry.
const PERSONA_ID_RE = /^[a-z0-9-]{1,64}$/;
```

Replace `seed` and the `applyEvent` signature:

```ts
function seed(e: HookEvent, now: number, persona?: string): AgentStatus {
  const { role, name } = identify(e.session_id, e.branch, e.cwd);
  return {
    sessionId: e.session_id, name, role,
    ticket: parseTicket(e.branch), state: "working",
    doing: "starting up", cwd: e.cwd, branch: e.branch, updatedAt: now,
    // Set at launch by the dashboard and inherited by this hook from the claude
    // process. Only the id is stored; the server resolves the rest.
    ...(persona && PERSONA_ID_RE.test(persona) ? { persona } : {}),
  };
}

export function applyEvent(prev: AgentStatus | null, e: HookEvent, now: number, persona?: string): AgentStatus | null {
  const base = prev ?? seed(e, now, persona);
```

The rest of `applyEvent` is unchanged: every non-`SessionStart` branch spreads
`...base`, so the persona carries forward on its own. Update only the
`SessionStart` case:

```ts
    case "SessionStart":
      return seed(e, now, persona);
```

In `main()`, replace the `applyEvent` call:

```ts
  const next = applyEvent(prev, e, Date.now(), process.env.AGENT_PERSONA);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hook-status.test.ts`
Expected: PASS (all existing tests still pass — the new parameter is optional)

- [ ] **Step 5: Commit**

```bash
git add hooks/status.ts tests/hook-status.test.ts
git commit -m "feat: bind a launched persona to its session via AGENT_PERSONA"
```

---

### Task 4: Compose the launch command

**Files:**
- Modify: `src/ghostty.ts` (extract `buildLaunchInput`, extend `spawnAgent`)
- Test: `tests/ghostty-launch.test.ts` (create)

**Interfaces:**
- Consumes: `Persona`, `getPersona`, `composePrompt` (Task 1)
- Produces:
  - `buildLaunchInput(task: string, opts: { model?: string; permissionMode?: string }, persona: Persona | null): string`
  - `spawnAgent(cwd, task, opts?: { model?; permissionMode?; worktree?; persona? })`

- [ ] **Step 1: Write the failing test**

Create `tests/ghostty-launch.test.ts`:

```ts
import { test, expect } from "bun:test";
import { buildLaunchInput } from "../src/ghostty";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ghostty-launch.test.ts`
Expected: FAIL — `buildLaunchInput is not a function`

- [ ] **Step 3: Extract and extend**

In `src/ghostty.ts`, add to the imports:

```ts
import { composePrompt, getPersona, type Persona } from "./lib/personas";
```

Add above `spawnAgent`:

```ts
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** The exact line typed into the new terminal. Pure and exported so the command
 *  shape is unit-tested without driving AppleScript.
 *  `model`/`permissionMode` are checked against fixed allowlists — an unknown
 *  value is dropped, never interpolated. The persona rides in twice: its prompt
 *  as --append-system-prompt (so it survives compaction and never shows up in
 *  the CHAT tab), and its id as an env var the session's hooks inherit, which is
 *  what binds the persona to the real session id. */
export function buildLaunchInput(
  task: string,
  opts: { model?: string; permissionMode?: string },
  persona: Persona | null,
): string {
  let flags = "";
  if (opts.model && ALLOWED_MODELS.has(opts.model)) flags += ` --model ${opts.model}`;
  if (opts.permissionMode && ALLOWED_PERMISSION_MODES.has(opts.permissionMode)) flags += ` --permission-mode ${opts.permissionMode}`;
  if (persona) flags += ` --append-system-prompt ${shq(composePrompt(persona))}`;
  const env = persona ? `AGENT_PERSONA=${persona.id} ` : "";
  return `${env}claude${flags} ${shq(task)}\n`;
}
```

Then in `spawnAgent`, widen the options and replace the command-building block
(the `quotedTask` / `flags` / `input` lines) with:

```ts
export async function spawnAgent(
  cwd: string,
  task: string,
  opts?: { model?: string; permissionMode?: string; worktree?: string; persona?: string },
): Promise<ActionResult> {
  let launchCwd = cwd;
  if (opts?.worktree) {
    const wt = await createWorktree(cwd, opts.worktree);
    if (!wt.ok) return { ok: false, error: wt.error ?? "could not create worktree" };
    launchCwd = wt.path!;
  }
  // An unknown persona id resolves to null and is ignored, the same way an
  // unknown model is — never interpolated into the command.
  const persona = opts?.persona ? getPersona(opts.persona) : null;
  const input = buildLaunchInput(task, opts ?? {}, persona);
```

The AppleScript block below is unchanged — AppleScript string literals accept
raw newlines, so a multi-line prompt needs no extra escaping.

Update the doc comment above `spawnAgent` to mention `opts.persona`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ghostty-launch.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add src/ghostty.ts tests/ghostty-launch.test.ts
git commit -m "feat: launch with a persona system prompt and AGENT_PERSONA"
```

---

### Task 5: Server wiring

**Files:**
- Modify: `src/server.ts` (`readSnapshot`, `GET /personas`, `/action/spawn`)
- Test: `tests/server.test.ts` (append)

**Interfaces:**
- Consumes: `loadPersonas`, `applyPersonas` (Tasks 1–2); `spawnAgent` (Task 4)
- Produces: `GET /personas` → `[{ id, name, role, skills }]` (no prompt text is sent to the browser)

- [ ] **Step 1: Write the failing test**

Append to `tests/server.test.ts` (follow the file's existing pattern for starting
a server and picking a port):

```ts
test("GET /personas lists the built-ins without prompt text", async () => {
  const srv = makeServer(0, { scan: false });
  const res = await fetch(`http://localhost:${srv.port}/personas`);
  expect(res.status).toBe(200);
  const list = (await res.json()) as any[];
  expect(list.map((p) => p.id)).toEqual(["backend-dev", "editor", "frontend-ux", "scrum-master"]);
  expect(list[0].name).toBeTruthy();
  expect(list[0].role).toBeTruthy();
  expect(Array.isArray(list[0].skills)).toBe(true);
  expect(list[0].prompt).toBeUndefined();
  srv.stop();
});
```

Also append a test for the snapshot wiring, using the harness already at the top
of that file (`reset`, `valid`, `dir`) — this covers the more important half:

```ts
test("readSnapshot resolves a persona onto the agent", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", persona: "backend-dev", name: "NOVA", role: "General" }));
  const [agent] = readSnapshot(dir, Date.now()).agents;
  expect(agent.name).toBe("ANVIL");
  expect(agent.role).toBe("Backend Dev");
  expect(agent.sprite!.body).toBe("robot");
});

test("readSnapshot leaves a persona-less agent alone", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", name: "NOVA", role: "General" }));
  expect(readSnapshot(dir, Date.now()).agents[0].name).toBe("NOVA");
});
```

Note this is the first test in the suite to start a live server. `makeServer`
returns a Bun server with `.port` and a `.stop()` already patched to close its
watcher, so `makeServer(0, …)` on an ephemeral port and `srv.stop()` is safe.
Import `makeServer` alongside `readSnapshot` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server.test.ts`
Expected: FAIL — status 404 on `/personas`, and `Expected: "ANVIL", Received: "NOVA"`

- [ ] **Step 3: Wire the server**

In `src/server.ts`, add to the imports:

```ts
import { loadPersonas, applyPersonas } from "./lib/personas";
```

In `readSnapshot`, replace the return expression:

```ts
  // personas resolve INSIDE applyOverrides so a name you typed yourself wins:
  // user override > persona > inferRole > hashed codename
  return buildSnapshot(applyOverrides(applyPersonas(agents, loadPersonas()), readOverrides(dir)), now, {
    committedCwds,
    designations: readLineState(dir),
  });
```

Add a route beside the other `GET` handlers (next to `/repo`, around line 126):

```ts
      if (url.pathname === "/personas") {
        // id/name/role/skills only — the prompt body is never sent to the browser
        return json(loadPersonas().map(({ id, name, role, skills }) => ({ id, name, role, skills })));
      }
```

In the `/action/spawn` handler, add `persona` to the destructured body type
declaration and forward it:

```ts
          const persona = typeof body.persona === "string" && body.persona.trim() ? body.persona.trim() : undefined;
          return json(await spawnAgent(cwd, task, { model, permissionMode, worktree, persona }));
```

Add `persona?: string` to the inline `let body: {…}` type above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS across the whole suite

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: serve personas and resolve them into the snapshot"
```

---

### Task 6: The PERSONA select

**Files:**
- Modify: `src/ui/actions.ts` (`fetchPersonas`, extend `spawnAgent`)
- Modify: `src/ui/NewAgentModal.tsx`

**Interfaces:**
- Consumes: `GET /personas` (Task 5)
- Produces: `type PersonaInfo = { id: string; name: string; role: string; skills: string[] }`; `fetchPersonas(): Promise<PersonaInfo[]>`

- [ ] **Step 1: Add the client call**

In `src/ui/actions.ts`, extend `spawnAgent`:

```ts
export async function spawnAgent(cwd: string, task: string, opts?: { model?: string; permissionMode?: string; worktree?: string; persona?: string }): Promise<boolean> {
  const r = await post("spawn", { cwd, text: task, model: opts?.model, permissionMode: opts?.permissionMode, worktree: opts?.worktree, persona: opts?.persona });
  if (!r.ok) toast(r.error ?? "could not launch");
  return r.ok;
}
```

And add below it:

```ts
export type PersonaInfo = { id: string; name: string; role: string; skills: string[] };

/** The personas the server offers. Returns [] on any failure so a blip degrades
 *  to "no persona choice" rather than a broken modal. */
export async function fetchPersonas(): Promise<PersonaInfo[]> {
  try {
    const res = await fetch("/personas");
    if (!res.ok) return [];
    return (await res.json()) as PersonaInfo[];
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Add the select to the modal**

In `src/ui/NewAgentModal.tsx`, extend the imports:

```ts
import { spawnAgent, fetchPersonas, type PersonaInfo } from "./actions";
```

Add state beside the other `useState` calls:

```ts
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [persona, setPersona] = useState("");
```

Add an effect below the existing worktree effect:

```ts
  useEffect(() => { void fetchPersonas().then(setPersonas); }, []);
```

Forward it in `launch()`:

```ts
    const ok = await spawnAgent(folder.trim(), task.trim(), {
      model: model || undefined,
      permissionMode: permissionMode || undefined,
      worktree: worktree.trim() || undefined,
      persona: persona || undefined,
    });
```

Insert the control immediately **above** the `<div className="newagent-opts">`
block, so the persona gets its own full-width row (`.newagent-opts` is a flex row
of two; a third child would crowd it):

```tsx
        {personas.length > 0 && (
          <>
            <label className="pix newagent-label">PERSONA</label>
            <select className="reply-input newagent-select" value={persona} onChange={(e) => setPersona(e.target.value)}>
              <option value="">None</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>{p.role} · {p.name}</option>
              ))}
            </select>
          </>
        )}
```

Extend the hint text at the bottom of the modal, appending to the existing
sentence about worktrees:

```tsx
 A PERSONA starts the agent in a role — its skills, its look on the board.
```

- [ ] **Step 3: Build and verify by hand**

Run: `bun run build && bun run dev`

Open the printed URL, click **+ NEW AGENT**, and confirm:
- PERSONA lists `Backend Dev · ANVIL`, `Editor · QUILL`, `Frontend UX · PIXEL`, `Scrum Master · CADENCE`, plus `None`.
- The select sits on its own row above MODEL / PERMISSIONS and is not crowded.

Expected: all four present, default `None`

- [ ] **Step 4: Commit**

```bash
git add src/ui/actions.ts src/ui/NewAgentModal.tsx
git commit -m "feat: choose a persona when launching an agent"
```

---

### Task 7: Persona in the INFO tab

**Files:**
- Modify: `src/ui/ConversationDrawer.tsx`

**Interfaces:**
- Consumes: `fetchPersonas`, `PersonaInfo` (Task 6); `agent.persona` (Task 2)

- [ ] **Step 1: Load the persona list with the tab**

In `src/ui/ConversationDrawer.tsx`, add `fetchPersonas` and `PersonaInfo` to the
existing import from `./actions`, then add state beside the `repo` state:

```ts
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
```

Extend the existing INFO-tab effect (the one that loads `repo`) so it also loads
the persona list once when the tab opens — the list is small and static, so it
does not need to sit on the 4s poll:

```ts
  useEffect(() => {
    if (tab !== "info" || !agent.persona || personas.length) return;
    void fetchPersonas().then(setPersonas);
  }, [tab, agent.persona, personas.length]);
```

- [ ] **Step 2: Render the row**

Inside the `<div className="drawer-body info">` block, add immediately after the
`BRANCH` row:

```tsx
                {agent.persona && (() => {
                  const p = personas.find((x) => x.id === agent.persona);
                  return (
                    <div className="info-row">
                      <span className="info-k">PERSONA</span>
                      <span className="info-v">
                        {p ? p.role : agent.persona}
                        {p && p.skills.length > 0 ? ` · ${p.skills.join(", ")}` : ""}
                      </span>
                    </div>
                  );
                })()}
```

An agent with no persona renders nothing, and an id with no matching file falls
back to showing the raw id rather than disappearing.

- [ ] **Step 3: Build and verify by hand**

Run: `bun run build && bun run dev`

Launch an agent with the **Backend Dev** persona, click its desk, open **INFO**.
Expected: a `PERSONA` row reading
`Backend Dev · superpowers:test-driven-development, superpowers:systematic-debugging`.
Open the INFO tab on a persona-less session and confirm no PERSONA row appears.

- [ ] **Step 4: Commit**

```bash
git add src/ui/ConversationDrawer.tsx
git commit -m "feat: show an agent's persona and skills in the INFO tab"
```

---

### Task 8: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document personas**

In `README.md`, add a `## Personas` section after **The agent pane** and before
**Controls**:

```markdown
## Personas

An agent can be launched *as* someone. Pick a **PERSONA** in **+ NEW AGENT** and
the session starts with that role's system prompt — naming the skills it should
reach for — and takes that persona's name, role line, and sprite on the board.

Four ship with the app:

| persona | plays | reaches for |
| --- | --- | --- |
| `scrum-master` | CADENCE — sizes and clarifies work before it starts | `task-review`, `superpowers:writing-plans` |
| `editor` | QUILL — prose, docs, changelogs, commit messages | `superpowers:requesting-code-review` |
| `backend-dev` | ANVIL — data, state, server correctness, test-first | `superpowers:test-driven-development`, `superpowers:systematic-debugging` |
| `frontend-ux` | PIXEL — what the user sees and touches | `superpowers:brainstorming` |

They live in `personas/` — one markdown file each, YAML frontmatter plus a prompt
body. Edit one, or drop in your own; the file's `id` must match its filename and
`sprite.body` must be one of the characters in the sprite picker. A malformed
file is skipped, never fatal. Changes take effect on the next launch (and on the
next snapshot for the board), with no restart.

```markdown
---
id: frontend-ux
name: PIXEL
role: Frontend UX
sprite: { body: engineer, palette: 2 }
skills: [frontend-design, brainstorming]
---
You are the frontend/UX developer on this team. …
```

Two limits worth knowing. Claude Code skills are model-invoked, so `skills:`
tells an agent what to reach for — it can't force a skill to load. And a persona
is chosen **at launch**: it can't be applied to a session that's already running,
and a session started outside the dashboard has none.

Personas are bound to a session by an `AGENT_PERSONA` env var that the session's
hooks read, so a scanner-only session (no `install-hooks`) still *gets* its
system prompt but won't show the persona's name or sprite on the board — the same
trade as precise focus, prompt, and pause.

*(Not to be confused with Claude Code's own skills in `.claude/skills/` — those
are what a persona points at, not where personas live.)*
```

Also add a row to the **Controls** list:

```markdown
- **PERSONA** in **+ NEW AGENT** starts the agent in a role — see [Personas](#personas).
```

- [ ] **Step 2: Full verification**

Run:

```bash
bun test
bunx tsc --noEmit -p tsconfig.json
bun run build
```

Expected: all tests pass, no type errors, build succeeds.

- [ ] **Step 3: End-to-end manual verification**

Unit tests cannot see any of this. With `bun run dev` running and hooks installed
(`bun run install-hooks`):

1. **Each persona lands.** Launch all four, one per persona. Confirm each desk
   shows the persona's name, role line, and its own sprite — four visibly
   different characters.
2. **It's real, not a label.** Ask the Backend Dev agent to add a small feature
   and confirm it goes test-first; ask the Editor agent to write code and confirm
   it pushes back and edits prose instead.
3. **INFO.** Each pane's INFO tab shows the PERSONA row with the right skills.
4. **Name collision.** Launch two `backend-dev` agents at once. Confirm
   `uniquifyNames` suffixes a session-id fragment so both desks stay
   distinguishable.
5. **Override wins.** Rename a persona agent by clicking its name. Confirm your
   name sticks and survives a page reload.
6. **No persona.** Launch with PERSONA = None. Confirm today's behaviour is
   unchanged (inferred role or hashed codename).
7. **Bad file is survivable.** `echo 'broken' > personas/oops.md`, reload the
   board and open the modal. Confirm the board still renders and the other four
   personas still list. Delete the file afterward.
8. **Degradation.** `bun run uninstall-hooks`, launch a persona agent, and
   confirm the session still receives its system prompt (ask it what its role is)
   while the desk falls back to the inferred identity. Re-run
   `bun run install-hooks` afterward.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document agent personas"
```
