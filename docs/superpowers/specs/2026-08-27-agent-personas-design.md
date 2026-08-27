# Agent Personas — Design

**Date:** 2026-08-27
**Status:** Approved for planning
**Stack:** Bun · TypeScript · React

## 1. Purpose

Give a launched agent a **persona** — a role it actually plays, not a label it
wears. Picking "Frontend UX" in **+ NEW AGENT** starts that Claude session with a
persona system prompt naming the skills it should reach for, and paints its desk
so the role is readable at a glance.

Today the board has a thin, accidental version of this: `src/lib/role.ts` matches
branch keywords to a role line and codename (FORGE, SCRIBE, PROBE, SHIFT, SCOUT),
and `identity.ts` falls back to a hashed codename plus the repo name. That is
inference from a branch name — it never changes how the session behaves, and you
can't choose it. Personas make the same idea deliberate and behavioural.

## 2. Scope

**In scope:**
- A built-in set of persona files in the repo, editable, extensible by adding a file.
- A persona choice in the launch modal that shapes the session's system prompt.
- Persona-derived name, role line, and sprite on the board.
- Persona and its skills shown in the agent pane's INFO tab.

**Out of scope (deliberate, per brainstorming):**
- Model or permission-mode defaults per persona.
- Tool allow/deny restrictions per persona.
- An in-app persona editor.
- Assigning a persona to an already-running session.
- A `~/.agent-status/personas/` user overlay.

## 3. Key constraints (verified, not assumed)

These were checked against the real CLI and runtime before the design was fixed:

| Fact | Consequence |
| --- | --- |
| `--append-system-prompt` exists; `--append-system-prompt-file` does **not** | The prompt goes on the command line (~1–2KB against a ~1MB `ARG_MAX`). |
| AppleScript string literals accept **raw newlines** | Multi-line prompts pass through `asStr` unchanged. No escaping work. |
| `Bun.YAML` exists | YAML frontmatter parses with no new dependency. |
| Hooks are spawned by the `claude` process | A hook inherits the launch environment — this is what makes binding exact. |

Claude Code skills are **model-invoked**. A persona can name the skills it should
reach for; it cannot force-load them. This is persuasion, not configuration, and
the design does not pretend otherwise.

## 4. Architecture

```
NewAgentModal ──GET /personas──► server ──► src/lib/personas.ts (registry)
      │                                            ▲
      │ POST /action/spawn { persona }             │ personas/*.md
      ▼
 src/ghostty.ts  ──launches──►  AGENT_PERSONA=<id> claude \
                                  --append-system-prompt '<prompt>' '<task>'
                                          │
                                   (env inherited)
                                          ▼
                                  hooks/status.ts  ──writes persona id──►
                                          ~/.agent-status/<session_id>.json
                                                        │
                                                        ▼
                                  server.ts: applyPersonas → applyOverrides
                                                        │
                                                        ▼
                                              the board (sprite, role, name)
```

The persona id is the only thing that crosses the process boundary. Everything
else is resolved from it, at read time, from the registry.

### 4.1 `personas/*.md` — the definitions

One file per persona, YAML frontmatter and a prompt body:

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

| field | meaning |
| --- | --- |
| `id` | slug, `/^[a-z0-9-]{1,64}$/`, must equal the filename stem |
| `name` | display name on the desk, replacing the hashed codename |
| `role` | the role line under the name |
| `sprite` | `body` from the `BODIES` registry, `palette` index, optional `gear` (worker only) — see note below |
| `skills` | Claude Code skills the persona should reach for |
| body | the persona system prompt |

**Built-ins shipped:** `scrum-master`, `editor`, `backend-dev`, `frontend-ux`.
Sprites are drawn from what `sprite-data.ts` already has — worker+headset, owl,
robot, engineer, across four of the five palettes — so four agents on one board
read as four different people. Assignments are cosmetic and easy to re-pick.

### 4.2 `src/lib/personas.ts` — registry and resolution

```ts
export function listPersonas(): Persona[];          // for the modal + validation
export function getPersona(id: string): Persona | null;
export function composePrompt(p: Persona): string;  // body + generated skills line
export function applyPersonas(agents: AgentStatus[], personas: Persona[]): AgentStatus[];
```

Loads `personas/*.md` relative to `import.meta.dir`, validated with zod. A
malformed file is **skipped, not fatal** — the same posture as `parseStatus` and
the recent `.line.json` validation fix. One bad persona must never empty the
picker or crash a snapshot.

`composePrompt` appends a generated line naming the skills, e.g. *"Reach for
`frontend-design`, `brainstorming` via the Skill tool when the work calls for
it."* — so `skills:` stays declarative data rather than prose the author has to
remember to write twice.

`applyPersonas` mirrors `applyOverrides` in `overrides.ts`: pure, never mutates
its input, returns agents with `name` / `role` / `sprite` filled from the persona.

**Gear:** `AgentStatus.sprite` requires `gear: string`, but gear overlays are only
positioned for the `worker` body. A persona that omits `gear` resolves to `""`,
which `Sprite.tsx` already renders as no overlay (`GEAR[gear] || []`). So `gear`
stays optional in the persona file without widening the schema.

### 4.3 Launch — `src/ghostty.ts`

`spawnAgent` gains `opts.persona`, validated against the registry exactly as
`opts.model` is validated against `ALLOWED_MODELS` — an unknown id is silently
ignored, never interpolated. The composed terminal input:

```
AGENT_PERSONA=<id> claude [--model …] [--permission-mode …] \
  --append-system-prompt '<composed prompt>' '<task>'
```

The prompt is shell-quoted with the existing single-quote escaper. The env-var
prefix works because `initial input` is typed into a login shell.

### 4.4 Binding — `hooks/status.ts`

`seed()` reads `process.env.AGENT_PERSONA`, validates it as a slug, and stores it
as `persona` on the status file. `applyEvent` carries it forward from `prev` so a
later `PreToolUse` or `Stop` never drops it.

The hook stores **only the id**. It does not import the registry and does not
resolve names, roles, or sprites. Two things follow: the hook stays dumb, and
editing a persona file updates live desks instead of leaving stale values baked
into status JSON.

### 4.5 Precedence — `src/server.ts`

```ts
buildSnapshot(applyOverrides(applyPersonas(agents, personas), readOverrides(dir)), now, { … })
```

**user override > persona > `inferRole` > hashed codename**

Overrides are applied last and therefore win: a name you typed yourself always
beats the persona's. A session with no persona flows through `applyPersonas`
untouched, so today's behaviour is unchanged.

Note `uniquifyNames` inside `buildSnapshot` already suffixes a session-id
fragment when two agents share a name. Personas make that collision common —
launch two `backend-dev`s and both want the same name — so this existing
mechanism now carries real weight rather than being a rare-case guard.

### 4.6 Schema

`AgentStatus` gains `persona?: string`. Optional, so every existing status file
on disk stays valid.

### 4.7 UI

- **`NewAgentModal`** — a `PERSONA` select beside MODEL and PERMISSIONS, fed by a
  new `GET /personas`, defaulting to none.
- **The desk** — no change. The persona reaches it through the snapshot.
- **`ConversationDrawer`** — the INFO tab gains a persona line listing its skills,
  so you can see what a given agent was told it was.

## 5. Degradation

Binding rides on the hook, so a scanner-only session (no `install-hooks`) shows no
persona on its desk. The persona still **shapes** that session — the flag is on
the command line either way. Only the board look is lost, and only until hooks are
installed. This is the same trade the README already documents for precise focus,
prompt, and pause, so it needs no new concept to explain.

## 6. Testing

**Unit:**
- `personas.test.ts` — valid file parses; missing required field, malformed YAML,
  out-of-range palette, unknown sprite body, and `id` disagreeing with the
  filename are each skipped rather than thrown; `composePrompt` includes both the
  body and the generated skills line.
- `snapshot`/`overrides` — all four precedence tiers, including a user override
  beating a persona and a persona-less agent passing through unchanged.
- `hook-status.test.ts` — persona captured from the env on `SessionStart`,
  preserved across `PreToolUse` and `Stop`, absent when the env var is unset,
  rejected when it isn't a valid slug.
- `ghostty` — launch-command composition: env prefix present, prompt correctly
  quoted, unknown persona id dropped.

**Manual** (unit tests cannot see any of this):
- Launch each of the four personas; confirm desk sprite and role line, the INFO
  persona line, and that the agent *actually behaves in role*.
- Launch with no persona — behaviour unchanged.
- Launch with hooks uninstalled — system prompt still applies, desk falls back to
  the inferred identity.

## 7. Files touched

| file | change |
| --- | --- |
| `personas/*.md` | new — four built-in personas |
| `src/lib/personas.ts` | new — registry, `composePrompt`, `applyPersonas` |
| `src/schema.ts` | `persona?: string` |
| `hooks/status.ts` | capture `AGENT_PERSONA`, carry across events |
| `src/ghostty.ts` | `opts.persona`, env prefix, `--append-system-prompt` |
| `src/server.ts` | `GET /personas`, persona on `/action/spawn`, `applyPersonas` |
| `src/ui/NewAgentModal.tsx` | PERSONA select |
| `src/ui/actions.ts` | pass persona through `spawnAgent` |
| `src/ui/ConversationDrawer.tsx` | persona + skills in INFO |
| `README.md` | personas section |
| `tests/personas.test.ts` + existing suites | coverage per §6 |
