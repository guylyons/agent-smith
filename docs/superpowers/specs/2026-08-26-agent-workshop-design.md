# Agent Workshop — Design

**Date:** 2026-08-26
**Status:** Approved for planning
**Stack:** Bun · TypeScript · React

## 1. Purpose

A local dashboard that visually shows what Claude Code sessions are doing right
now: who's working, who's blocked and **needs you**, who's idle, what ticket each
is on, and a live line of tickets moving toward "merged." It reads status written
by Claude Code hooks — the dashboard never talks to Claude directly; it observes.

The look is fixed by `agent_workshop_mockup.html`: a SNES/CRT retro pixel-art
"workshop" — each agent is a pixel sprite at a desk with a state lamp, and a
kanban-style **THE LINE** shows ticket flow. This design ports that mock to a real,
data-driven React app and adds the hook scripts that make it light up end-to-end.

## 2. Scope

**In scope (v1):**
- The React + Bun dashboard, faithful to the mock's visuals.
- Claude Code hook scripts that write `~/.agent-status/<session_id>.json`.
- End-to-end: running a real Claude Code session makes a sprite appear and react.

**Out of scope (v1):**
- GitLab/git API integration for `review` / `merged` kanban stages (see §6).
- Controlling/spawning agents from the UI (this is observe-only).
- Auth, multi-user, remote hosting. Local single-user tool.

## 3. Architecture

Four pieces, each understandable and testable on its own.

```
Claude Code session
   │  (hook events: SessionStart, PreToolUse, Notification, Stop, SessionEnd)
   ▼
hooks/status.ts ──writes──► ~/.agent-status/<session_id>.json
                                     │
                              fs.watch (debounced)
                                     ▼
                            src/server.ts (Bun)
                          reads all *.json → snapshot
                                     │  SSE /events
                                     ▼
                            src/ui/ (React) — sprites, crew, THE LINE
```

### 3.1 `src/schema.ts` — the contract
The single source of truth for the JSON shape. Exports the `AgentStatus` type and a
Zod schema. Imported by **both** the hook writer and the server reader so they can
never drift.

```ts
type AgentState = 'working' | 'waiting' | 'idle';

interface AgentStatus {
  sessionId: string;      // stable key; drives sprite look
  name: string;           // display name (derived, see §5)
  role: string;           // "Component build", "Docs & changelog", ...
  ticket: string | null;  // "#4412" or null
  state: AgentState;
  waitingReason?: 'permission' | 'question';  // why it needs you
  doing: string;          // humanized current activity line
  cwd: string;
  branch: string | null;
  updatedAt: number;      // epoch ms; used for stale age-out
}
```
`waiting` == the mock's "NEEDS YOU" (clay lamp + `!` bubble). We keep only the three
states we can honestly observe; the mock's green `done` lamp is intentionally unused
in v1.

### 3.2 `hooks/status.ts` — the writer
One TypeScript script, run as `bun run hooks/status.ts`, dispatching on the hook
event name. It is the only component that knows Claude Code internals. Per event:

- **SessionStart** — create the file. Derive `branch`, `ticket`, `role`, `name`
  (§5). `state: 'working'`, seed the sprite from `sessionId`.
- **PreToolUse** — set `doing` = humanized tool + input (§5.3), `state: 'working'`,
  bump `updatedAt`.
- **Notification** — `state: 'waiting'`, `waitingReason: 'permission'`.
- **Stop** — if the stop payload's last assistant message is a question →
  `state: 'waiting'`, `waitingReason: 'question'`; else `state: 'idle'`.
- **SessionEnd** — delete the file (sprite leaves).

Writes are atomic (write temp file, rename) so the server never reads a half file.
The script reads the hook JSON payload from stdin, mutates the current file, writes
it back.

### 3.3 `src/server.ts` — the watcher
Bun server with two responsibilities:
1. Serve the built React app (static).
2. `GET /events` — SSE. On connect, send the current snapshot; thereafter push a new
   snapshot whenever the status dir changes.

`fs.watch(~/.agent-status)` with a short debounce (≈150ms) coalesces rapid writes.
On each fire it reads every `*.json`, validates via the Zod schema, **skips** any
that fail (mid-write / corrupt) keeping the last good snapshot for that key, ages
out entries older than N minutes (default 5) as a dead-session fallback, and emits
`{ agents: AgentStatus[], line: LineSnapshot }`.

### 3.4 `src/ui/` — the face
The mock ported to components, each a direct lift of a mock region:
- `Crt` — the fixed scanline/grille/glow/hum stack + tube toggle (3 modes).
- `Sprite` — ports `BASE` + `GEAR` + `sprite()` from the mock; palette & gear chosen
  deterministically from `sessionId` + `role`.
- `Crew` / `Desk` — the agent grid; lamp, `!` bubble, ticket chip, `doing` line.
- `TheLine` — the five-column kanban + animated belt.
- `Header` — title, on-shift count, stat line.
- `useSnapshot()` — subscribes to `/events` (SSE), holds the snapshot in state,
  reconnects on drop.

## 4. Data flow (one cycle)
1. Claude fires a hook → `hooks/status.ts` writes `<sessionId>.json` atomically.
2. `fs.watch` fires → server debounces → reads + validates all files.
3. Server builds a snapshot and pushes it over SSE.
4. `useSnapshot()` updates React state → sprites/lamps/line re-render.

## 5. Deriving identity from work context

### 5.1 Ticket
Parse the git branch: first run of digits, e.g. `feature/4412-card-variant → #4412`.
No number → `ticket: null` (chip shows `—`).

### 5.2 Role & name
A small keyword table maps branch/cwd signal → role, and role → a stable persona
name and sprite gear (mirrors the mock's SCOUT/FORGE/…). Fallback role "General"
with a neutral sprite. The sprite *palette* is a hash of `sessionId` so two sessions
in the same role still look distinct but each session is stable across its life.

### 5.3 Humanizing the `doing` line
Pure function `(toolName, toolInput) → string`, e.g.
`Edit {file_path:'…/card.twig'} → "editing card.twig"`,
`Bash {command:'bun test'} → "running bun test"`,
`Read {…issue…} → "reading issue #4412"`. Unknown tools fall back to the tool name.

## 6. THE LINE (kanban) — v1 decision
Five columns kept for visual fidelity; **only the three we can observe are
populated**. THE LINE is derived purely from the currently-present status files —
one crate per distinct ticket, placed by the state of the session(s) on it:
- **backlog** — the ticket's session(s) are all `idle` (present but not active).
- **working** — a session on it is `working`.
- **needs-you** — a session on it is `waiting` (takes precedence over working).

A ticket with no present file has no crate (there's nothing left to render). The
server emits `LineSnapshot = { stage: 'backlog'|'working'|'needs', tickets: string[] }[]`
covering all five stage keys (review/merged always empty in v1).

**review** and **merged** stay empty in v1 — they require GitLab/git branch state,
which hooks don't provide. A later addition (a small `git`/GitLab check in the
server) can fill them. We ship the honest three rather than fake the other two.

## 7. Error handling
- **Half-written JSON:** atomic writes on the hook side; Zod-validate + skip on the
  read side; last good snapshot retained per key.
- **Watch storms:** debounce `fs.watch`.
- **Dead sessions** (no `SessionEnd`): age out entries older than N minutes.
- **SSE drop:** client auto-reconnects and re-requests the snapshot on open.
- **Missing status dir:** server creates it on start.

## 8. Testing
- **Unit (`bun test`)** — pure functions: ticket parse, role/name infer, `doing`
  humanizer, state mapping, snapshot builder + stale age-out, THE LINE placement.
- **Integration** — write fixture JSON to a temp dir, hit `/events`, assert the
  emitted snapshot; feed a malformed file, assert it's skipped.
- **Hooks** — unit-test the pure derive logic; smoke-test by running a real session
  and confirming the file contents.
- **Real browser** — per project CLAUDE.md, final check with Claude in Chrome:
  confirm sprites, lamps, the `!` bubble on a real permission prompt, and THE LINE
  render correctly — not asserted from code alone.

## 9. Project layout
```
package.json
tsconfig.json
hooks/status.ts          # the single hook writer
src/
  schema.ts              # AgentStatus + Zod (shared contract)
  server.ts              # Bun static + SSE watcher
  lib/                   # pure derive/humanize/snapshot fns (unit-tested)
  ui/
    index.tsx App.tsx
    Crt.tsx Sprite.tsx Crew.tsx TheLine.tsx Header.tsx useSnapshot.ts
    sprite-data.ts       # BASE + GEAR ported from the mock
docs/superpowers/specs/2026-08-26-agent-workshop-design.md
```
`agent_workshop_mockup.html` stays as the visual reference of record.
