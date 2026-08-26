# Agent Workshop

A live status dashboard for Claude Code sessions, styled as a pixel-art workshop.
Claude Code hooks report each session's state (working / waiting / idle) as it
happens; a small server renders those states as sprites on a shop floor, with a
"THE LINE" kanban strip for tickets that need attention.

## Quick start

```bash
bun install
bun run build   # bundles src/ui into dist/ (dist/ is not tracked; rebuild after UI changes)
bun run dev      # starts the dashboard server and prints the URL
```

Open the printed URL in a browser to see the workshop. With no hooks firing yet,
the shop floor will be empty — install the hooks (below) and start a Claude Code
session to see a sprite appear.

## Installing the hooks

The dashboard is driven entirely by `hooks/status.ts`, which Claude Code invokes
as a command hook on session lifecycle events. It reads one JSON event on stdin,
updates (or removes) a status file under `~/.agent-status/<session_id>.json`, and
exits.

To wire it into a Claude Code project:

1. Copy `.claude/settings.json` from this repo into the project you want to
   monitor (or merge its `hooks` block into that project's existing
   `.claude/settings.json`).
2. Edit every hook command in that file so the path to `hooks/status.ts` is the
   **absolute path** to *this* repo's `hooks/status.ts` on your machine, e.g.:

   ```json
   "command": "bun run /Users/you/path/to/agentsmith/hooks/status.ts"
   ```

   The hook registration covers `SessionStart`, `PreToolUse` (matcher `"*"`),
   `Notification`, `Stop`, and `SessionEnd` — the events needed to seed a
   session, mark it busy, mark it waiting, and clean it up.
3. Start `bun run dev` (this repo) and open the dashboard. Start (or continue)
   a Claude Code session in the monitored project — its sprite should appear
   on the shop floor within one hook event.

### Branch resolution (no `jq` dependency)

`applyEvent` needs a `branch` (it's used to infer the agent's name/role and to
parse a ticket number, e.g. `feature/4412-card-component` → ticket `#4412`).
Claude Code's hook payload does not include the branch, so it has to be added
before `applyEvent` sees it.

Rather than requiring `jq` on `PATH` to splice `branch` into the event JSON
(the naive approach), `hooks/status.ts` resolves the branch itself: in `main()`,
if the incoming event has no `branch` field (or it's `null`), it shells out to
`git -C <cwd> branch --show-current` (where `cwd` comes from the event) and
uses that. `applyEvent` itself stays pure — it only ever consumes a `branch`
that's already present on the event; it never touches `git` or the filesystem.
This means the hook commands in `.claude/settings.json` can be a plain
`bun run <ABS>/hooks/status.ts` with no shell pipeline and no `jq` requirement.
If you'd rather resolve the branch outside the process (e.g. because `cwd` in
the event isn't the repo you want), you can still pass `branch` explicitly in
the piped-in JSON and the hook will use that instead.

### `AGENT_STATUS_DIR`

Status files are written to `~/.agent-status/` by default. Set
`AGENT_STATUS_DIR` to point the hook (and the server that reads the same
directory) somewhere else, e.g. for testing multiple isolated instances side
by side:

```bash
export AGENT_STATUS_DIR=/tmp/my-agent-status
```

## Manual smoke test

You can exercise the hook directly without Claude Code:

```bash
echo '{"hook_event_name":"SessionStart","session_id":"smoke1","cwd":"'$PWD'","branch":"feature/4412-card-component"}' | bun run hooks/status.ts
cat ~/.agent-status/smoke1.json   # state: "working", ticket: "#4412"

echo '{"hook_event_name":"Notification","session_id":"smoke1","cwd":"'$PWD'","branch":"feature/4412-card-component"}' | bun run hooks/status.ts
cat ~/.agent-status/smoke1.json   # state: "waiting", waitingReason: "permission"

echo '{"hook_event_name":"SessionEnd","session_id":"smoke1","cwd":"'$PWD'","branch":"feature/4412-card-component"}' | bun run hooks/status.ts
ls ~/.agent-status/smoke1.json    # gone
```

## v1 limitation: THE LINE only shows working/waiting

THE LINE (the kanban strip) currently only ever populates its "in progress" and
"needs you" columns, driven by each session's live `state`. The `review` and
`merged` columns are part of the layout but stay empty in v1 — populating them
requires knowing PR/MR review status and merge state, which means integrating
with GitLab/GitHub (or local git) beyond what a Claude Code hook payload
exposes. That integration is out of scope for this project's first version.

## Testing

```bash
bun test           # unit tests (pure logic: applyEvent, schema, snapshot, etc.)
bunx tsc --noEmit -p tsconfig.json   # typecheck
```
