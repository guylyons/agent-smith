# Orchestration: scrum master → workers via THE LINE

2026-08-28. Goal: one agent (scrum master) breaks work into cards, assigns them
to worker agents, and every agent drives its own ticket — comments as it goes,
moves the card as its status changes — reliably and unattended.

## Why it doesn't work today

1. **The card protocol was built but never landed.** `cardTaskPrompt()` (card id,
   board path, STEP 1/2/3 move-and-comment protocol) sits staged, uncommitted,
   in `.claude/worktrees/interface-changes-v1`. Main's SEND TASK sends only
   title + description + column instruction, so a worker never learns the board
   exists.
2. **No agent-facing write path.** The UI posts the whole board; agents were to
   hand-edit `.line.json`. Concurrent writers clobber each other (whole-file
   last-write-wins).
3. **The scrum-master persona is a sizing analyst**, with no board knowledge and
   no orchestration verbs. All verbs (spawn, prompt) live in the browser only.
4. **Non-ASCII text is corrupted** crossing the pty into a session (verified
   downstream of AppleScript). Protocol text and notifications must be ASCII.
5. **No supervision loop.** A session sleeps between turns; nobody wakes the
   scrum master when a worker comments or stalls.
6. **Compliance is probabilistic** (the VOLT incident: reused agent skipped
   In Progress, committed against instructions, worked an unassigned card).

## Plan

- **Phase 1 — land the stranded work.** Commit `interface-changes-v1`, merge to
  main, resolve conflicts with `commentNotifyText`/audit fixes. Make all
  generated protocol text pure ASCII. Move card_023d9ffd to Done.
- **Phase 2 — card-scoped HTTP API.** `GET /board`, `GET /agents`,
  `POST /action/card-add|card-move|card-comment|card-assign`, each applied
  server-side against a fresh board read (serialized; no clobber). Rewrite the
  task footer to exact `curl` commands (server injects its own URL). Agents
  never hand-edit `.line.json`.
- **Phase 3 — server-side SEND TASK + notifications.** `POST /action/send-task`
  composes the prompt server-side (UI uses it too). Worker card-move/card-comment
  via the API notifies live scrum-master sessions (skipping the author's own
  session by name), so orchestration is event-driven, not polled.
- **Phase 4 — personas.** Rewrite `scrum-master` as the orchestrator (owns THE
  LINE; creates/assigns cards, spawns workers per card — fresh spawn into a
  worktree by default — monitors, nudges, verifies Done criteria). Add a short
  board-etiquette note to worker personas.
- **Phase 5 — guardrails + permissions.** Footer scoping lines ("this replaces
  any prior task; only this card; obey card constraints"). Worker spawns default
  to `acceptEdits`; worktree spawns get a `.claude/settings.local.json`
  allowlisting only `curl http://localhost:<port>/*` so board updates never
  stall on a permission prompt.
- **Phase 6 — verify.** Unit tests per endpoint/prompt shape, typecheck, build,
  then a live end-to-end run driven by a real scrum-master session.
