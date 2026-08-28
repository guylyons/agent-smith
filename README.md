# Agent Workshop

A live board of your open Claude Code sessions, styled as a SNES/CRT pixel-art
workshop. Every open session shows up as a person at a desk — with the ticket
they're on, what they're doing right now, whether they're **working**, **idle**,
or **need you** (a permission prompt or a question), and a badge when they have
active subagents. "THE LINE" is a simple, editable kanban board — renamable,
draggable columns and cards, with a per-column instruction any agent can read.

![the workshop](docs/workshop.png)

It connects to your sessions two ways, working together:

- **Hooks** (real time) — Claude Code calls `hooks/status.ts` on session events,
  so activity, permission prompts, and questions show up the instant they happen.
  A permission prompt leaves **no trace in the transcript**, so it's the one thing
  only the hooks can see: without them installed, a session stopped at a permission
  prompt reads as **working** (busy on the tool), not **needs you**. Install the
  hooks if you want permission prompts on the board.
- **Transcript scanner** (fills the gaps) — the server periodically reads your
  session transcripts under `~/.claude/projects`, so windows you already have
  open appear immediately, without waiting for them to act or be restarted. It
  only surfaces a session if a matching **running `claude` process** exists, so
  old transcripts and internal sub-sessions don't show up as phantom agents.

Both write one status file per session to `~/.agent-status/<session_id>.json`,
keyed by the real session id so they never double-count a session.

## Quick start

```bash
bun install
bun run install-hooks   # recommended — required to see permission prompts (see above)
bun run dev             # builds if needed, starts the dashboard, prints the URL
```

Open the printed URL. Your currently-open sessions appear right away (via the
scanner). New sessions report automatically via the hooks; sessions you already
have open won't fire hooks until you restart them, but the scanner keeps
showing them in the meantime.

> `bun run dev` serves the pre-built `dist/`. After changing anything under
> `src/ui`, run `bun run build` to rebuild it (`dist/` is not tracked).

### Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Starts the dashboard server (with the scanner running) and prints its URL |
| `bun run build` | Builds `src/ui` into `dist/` (minified) — run after any UI change |
| `bun test` | Runs the unit test suite |
| `bun run scan` | Runs one scan pass over your real transcripts, reports how many open sessions it wrote |
| `bun run install-hooks` | Merges the status hooks into `~/.claude/settings.json` (backs it up first) |
| `bun run install-mcp` | Registers the board's MCP server with Claude Code (user scope) — see [the MCP server](#the-board-as-mcp-tools) |
| `bun run mcp` | Runs the board MCP server on stdio (what the registration launches; handy for debugging) |
| `bun run uninstall-hooks` | Removes only this repo's hook entries |

## Connecting your sessions

### `bun run install-hooks` (recommended)

Installs the hooks at the **user level** (`~/.claude/settings.json`) so *every*
session in *every* project reports. The installer:

- backs up your existing settings to `~/.claude/settings.json.agentworkshop.bak`,
- adds the five events (`SessionStart`, `PreToolUse`, `Notification`, `Stop`,
  `SessionEnd`) only if they aren't already present (non-destructive, idempotent),
- uses absolute paths to `bun` and this repo's `hooks/status.ts`.

Undo any time with `bun run uninstall-hooks` (removes only this repo's hook
entries; anything else you have stays).

### Just the scanner, no hooks

`bun run dev` scans transcripts on its own, so you get a read-only view of open
sessions even without installing hooks. You lose the real-time signals the
transcript can't see — most importantly, **permission prompts** flipping a
session to "need you" the moment they appear — and precise terminal targeting
for focus/prompt/pause (see below).

## The board

Each open session is a pixel character with:

- **name / sprite** — a stable codename + pixel look derived from the session
  id (a branch matching a known kind of work — component, docs, tests,
  migration, triage — gets that persona), or a character you've picked yourself.
- **role line** — the repo the session is working in (or the matched work type).
- **ticket** — parsed from the git branch (`fix/115-primary-nav` → `#115`).
- **doing** — the current tool activity, humanized (`editing card.twig`,
  `running bun test`; long shell commands are clipped to one line).
- **state** — `working` while active; `waiting` ("NEED YOU") for a permission
  prompt or a question it ended its turn on; `idle` otherwise.
- **subagent badge** — a small `⊂N` badge when the session has active `Task`
  subagents (a parent delegating to subagents is shown as working, not idle).

### THE LINE

A simple, fully editable kanban board. Everything is renamable and draggable,
and **each column carries an instruction** describing what to do with work that
lands in it — so the board is not just a tracker, it's something an agent can
read and act on.

- **Columns** — click a name to rename it, drag the `⠿` grip to reorder, `✕` to
  delete (with its cards), `+ COLUMN` to add one. Each column has an instruction
  field, e.g. _"Once done, ensure the worktree is clean and committed, then share
  a report in the ticket."_
- **Cards** — type in `+ add card` to add one, drag a card to any column, `✕` to
  delete. **Click a card** to open its detail modal: edit the title and a fuller
  description, set an assignee, and hold a comment thread.
- **Assign a card to an agent** — in the card's detail modal, the **ASSIGNEE**
  picker lists the live agent sessions; choosing one records it on the card (kept
  visible, marked _(ended)_, even after that session closes).
  - **▸ SEND TASK** sends the assigned agent the card's task — its **title +
    description + column instruction**, plus a protocol footer naming the card,
    the column flow, and the exact `curl` commands to move itself and comment —
    composed and delivered server-side, with a "Sent task to …" note dropped in
    the thread.
  - **+ NEW AGENT FOR THIS CARD** opens the New Agent modal pre-filled with that
    same task-plus-footer, so you can launch a fresh session (persona, model,
    worktree) to work it.

A fresh board starts with `Backlog · In Progress · Review · Done`; reshape it
however you like.

### The card API (how agents drive their own tickets)

Agents never edit the board file. The server exposes a card-scoped API, and the
protocol footer every sent task carries teaches the agent to use it:

- `GET /board` — columns (with instructions), cards, comments, and the board's
  path; `GET /agents` — the live sessions with resolved names/roles.
- `POST /action/card-add | card-move | card-update | card-comment | card-assign |
  send-task` — each is applied server-side against a fresh read of the board, so
  an agent's move or comment can never clobber (or be clobbered by) the UI's
  whole-board write or another agent. `card-update` edits a card's own text
  (title, description); fields you leave out are untouched.

A worker follows the footer: move its card to the working column and comment
before starting, comment as it learns things, comment and move it on when done.
Every agent-made move/comment also **wakes the sessions that care** — the card's
assignee and any live scrum-master session (never the author itself) get a short
`[THE LINE] …` note typed into their terminal, so supervision is event-driven,
not polled. Human comments posted in a card's thread are likewise delivered to
the assigned agent.

**Orchestration**: launch a session with the `scrum-master` persona and hand it
work — it sizes and splits the work into cards, spawns a fresh worker per card
(persona-matched, in an isolated worktree, `acceptEdits`), assigns and sends
tasks, reacts to board notifications, verifies a column's instruction before
advancing a card, and nudges stalled ones. A fresh worktree is seeded with a
`.claude/settings.local.json` allowlisting exactly the board `curl`s and local
git verbs, so a worker updates its ticket without stalling on permission
prompts (spawn/kill/prompt endpoints and `git push` still require a human).

### The board as MCP tools

The same card API, as tools instead of `curl`. Register it once and every Claude
session — in any project — can read the board and drive its ticket directly:

```bash
bun run install-mcp     # claude mcp add --scope user the-line -- bun run src/mcp.ts
claude mcp list         # the-line: … - ✔ Connected
```

Nine tools, named for what they do:

| Tool | What it does |
| --- | --- |
| `board_read` | Every column with its instruction, one line per card — the digest you start from |
| `card_read` | One card in full: description, assignee, column instruction, every comment |
| `card_create` | New card in a column, with a description |
| `card_update` | Rename a card, rewrite its description, or both |
| `card_move` | Move it to another column (notifies the other side) |
| `card_comment` | Post a comment (notifies the other side) |
| `card_assign` | Bind a live session to the card, or `null` to clear |
| `card_send_task` | Hand the card's composed task to its assigned session |
| `agents_list` | The live sessions — the only things a card can be assigned to |

Writes go through the dashboard's HTTP actions, not the board file, so an MCP
write is exactly as safe as the `curl` it replaces: applied against a fresh read,
and pushed straight to the open UI. **The dashboard has to be running** — if it
isn't, every tool says so and tells you to start it.

Comments and moves are signed automatically. `AGENT_WORKSHOP_AUTHOR` names the
author if you set it; otherwise the server asks the dashboard which live agent is
working in this folder and signs with that codename, falling back to a generic
one when the folder is ambiguous.

Remove it with `claude mcp remove --scope user the-line`.

The board itself is stored in `~/.agent-status/.line.json` so it survives
restarts. The browser client owns manual edits and writes the full board; the
server sanitizes every write before saving.

```jsonc
// ~/.agent-status/.line.json
{
  "version": 3,
  "columns": [
    { "id": "backlog", "name": "Backlog", "instruction": "" },
    { "id": "done", "name": "Done",
      "instruction": "Once done, ensure the worktree is clean and committed, then share a report in the ticket." }
  ],
  "cards": [
    { "id": "card_1a2b3c4d", "title": "#123 fix login bug", "columnId": "backlog",
      "description": "Users are locked out after a password reset.",
      "assignee": { "id": "<sessionId>", "name": "NOVA" },   // a live agent session
      "comments": [ { "id": "cmt_9f8e", "author": "You", "text": "Sent task to NOVA.", "at": 1787840000000 } ] }
  ]
}
```

## The agent pane

Click a desk to open its pane, with two tabs:

- **CHAT** — the full conversation, with markdown rendering (code, tables,
  bold). Send a message any time; it's echoed optimistically before the
  transcript confirms it. If the session ended a turn on a multiple-choice
  question (`AskUserQuestion`), the options render inline so you can answer
  without switching to the terminal. When it's blocked on something else — a
  permission prompt, a plan approval — the pane names the exact tool and
  input it's stuck on (`Bash · rm -rf build/`) and offers
  **↗ ANSWER IN TERMINAL**. Permission prompts are answered in the terminal
  by design: the dashboard is an unauthenticated local page, so it will show
  you the command but never approve it for you. A **subagents** section
  lists the session's live subagents with their description and current
  activity.
- **INFO** — pwd, branch (+ ticket), working-tree status, and recent commits.

![conversation pane](docs/drawer.png)
![live subagents](docs/subagents.png)

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
skills: [superpowers:brainstorming]
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

## Controls

- **Click the sprite** (on a desk or in the pane) to pick a custom character —
  a character + palette + gear picker, overriding the deterministic default.
  Characters include the human **worker** and **engineer** plus standalone
  critters/droids — **cat**, **fox**, **owl**, **robot** — each recolored by any
  of the five palettes. (Gear overlays apply only to the human worker.)
- **↗ TERMINAL** jumps to the session's exact Ghostty tab.
- **Click the name** (in the pane) to rename the agent. Stored in
  `~/.agent-status/.overrides.json` and survives restarts.
- **⏸ pause** interrupts the agent's current turn (like pressing Esc/Ctrl-C
  once). The session stays open; resume by typing in it. Confirmed before it
  fires.
- **◼ stop** ends the agent — it closes the session's Ghostty tab. Confirmed
  before it fires (two-step). Targets the exact tab (marker/title), never a
  cwd guess.
- **Send a prompt or answer** from the UI — types the text into the session's
  terminal and submits it, without ever focusing/activating the terminal (you
  stay in the web UI).
- **+ NEW AGENT** launches a brand-new Claude session: pick a folder (recent
  folders are offered), a task, and optionally a model (Opus/Sonnet/Haiku) and
  permission mode (Default/Plan/Accept edits/Bypass). It opens in a new Ghostty
  tab running `claude [--model …] [--permission-mode …] '<task>'` and appears on
  the board via the scanner once it starts.
- **PERSONA** in **+ NEW AGENT** starts the agent in a role — see [Personas](#personas).

![new agent](docs/newagent.png)
![sprite picker](docs/spritepicker.png)

Precise focus/prompt/pause need the pid + tty the hooks capture, so they work
best with `install-hooks`. A scanner-only session (no hooks) falls back to
cwd-level focus and can't be paused (the button reports this).

## Alerts

The **🔔 ALERTS** toggle (top of the board) fires a desktop notification plus a
short synthesized beep the moment a session transitions into "need you". It's
off by default, remembers your choice, and only alerts on *new* transitions —
not for sessions already waiting when you load the page.

## Backgrounds

The **BG** button cycles five self-contained CSS art backgrounds — night,
stars, synth, grid, dusk — and remembers your pick. Each carries a very subtle
idle animation (a drifting nebula, twinkling stars, a slowly scrolling synth
horizon, a barely-panning blueprint grid, a gently breathing dusk sky) — all
disabled automatically under `prefers-reduced-motion`.

## How targeting works

The dashboard finds a session's exact Ghostty terminal, most precise first: a
one-shot title marker it writes to the session's **tty** (hooks) → Claude's
task title, which equals the Ghostty tab title (works from the scanner alone)
→ the working directory, as a last resort (imprecise — many tabs can share one
— so it's only used for focusing, never for sending input). Pausing needs the
**pid** the hooks capture, so it can verify a live `claude` process before
signaling it.

## Requirements & limits

- **macOS + Ghostty** — terminal actions use Ghostty's AppleScript dictionary.
- **Single-user, local tool** — no auth; status files live in a local
  directory.
- **`AGENT_STATUS_DIR`** — overrides where status files live (default
  `~/.agent-status/`); useful for isolated testing.
- **`AGENT_SCAN_FRESH_MS`** — how recently a transcript must have changed to
  count as "open" (default 15 min).

## Testing

```bash
bun test                              # unit tests (pure logic)
bunx tsc --noEmit -p tsconfig.json    # typecheck
```
