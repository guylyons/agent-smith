# The Needs-You Pipeline — Design

**Date:** 2026-08-27
**Status:** Approved for planning
**Stack:** Bun · TypeScript · React

## 1. Purpose

When an agent stops and needs you, the board must (a) say so **immediately**,
(b) say **what** it is stuck on, and (c) let you **unstick it from the web UI**.

Today all three fail, in three different ways. This design fixes the pipeline
that carries a blocking moment from the session to the dashboard and your answer
back again.

## 2. The three observed failures

Confirmed against the real transcripts and the running install, not assumed:

| # | Symptom | Root cause |
| --- | --- | --- |
| 1 | Card reads `WORKING`; nothing signals it needs you | `PreToolUse` fires the instant `AskUserQuestion` begins, but `hooks/status.ts` maps every tool to generic `working`. The board only learns it is a question on the next scanner pass — up to 20s later. |
| 2 | Card reads `NEEDS YOU`; the pane is empty | Only `AskUserQuestion` is renderable. A permission prompt sets `waiting/permission` and the pane has no panel for it, so it renders nothing at all. |
| 3 | `▸ SEND ANSWER` does nothing | `sendPrompt` types `"Opt A \| Opt B"` as text into what is actually a **selection widget** that asks one question at a time. The characters are consumed as navigation; the answer never lands. |

Supporting facts established during brainstorming:

- A pending `AskUserQuestion` **is** flushed to the transcript while it blocks
  (verified: `tool_use` at `01:28:28`, its `tool_result` at `01:30:18` — a 110s
  window). Detection is therefore possible; the pane was not the bottleneck.
- `AskUserQuestion` appears 108 times across 141 local transcripts. This is a
  hot path, not an edge case.
- `ExitPlanMode` appears 0 times locally, but plan approval is the same *shape*
  of blocking moment and falls out of the generic mechanism below for free.

## 3. Scope

**In scope:**
- Instant `NEEDS YOU` at `PreToolUse` for question and plan-approval blocks.
- A pane panel for **every** blocking reason, naming the blocked tool and input.
- Answer delivery that actually reaches the session, for single- and
  multi-question asks alike.

**Out of scope (deliberate):**
- Approving or denying permission prompts from the browser. The dashboard is an
  unauthenticated localhost page (see README, *Requirements & limits*); it will
  name the blocked command and hand you to the terminal, never green-light it.
- Treating a turn that ends with a prose `?` as a question. The existing README
  note stands, and this failure mode was explicitly **not** among those observed.
- Widening the scanner's 64KB transcript tail to match the pane's 512KB. A
  pending block is by definition the newest content in the file, so it is always
  inside both windows. Theoretical mismatch, real scan cost.

## 4. Architecture

```
 hooks/status.ts ──PreToolUse(AskUserQuestion|ExitPlanMode)──► waiting/{question,plan}
        │                                                            │
        │  (instant, no scan latency)                                │
        ▼                                                            ▼
 ~/.agent-status/<id>.json ◄──mergeForWrite pin──── src/scan.ts ──► desk card
        │
        └──GET /conversation──► conversation.ts { question, blocked } ──► pane
                                                                          │
 ConversationDrawer ──POST /action/answer──► ghostty.ts answerQuestion ────┘
                                              (Esc, then prose + Enter)
```

## 5. Section 1 — Detection becomes instant and generic

`applyEvent` in `hooks/status.ts` gains one special-case on `PreToolUse`:

| tool | result |
| --- | --- |
| `AskUserQuestion` | `waiting` / `question` · "waiting on your answer" |
| `ExitPlanMode` | `waiting` / `plan` · "waiting on plan approval" |
| anything else | `working` (unchanged) |

Consequences:

- `schema.ts` — `waitingReason` becomes `["permission", "question", "plan"]`.
- `scan.ts` — `mergeForWrite` currently pins only `permission` against being
  overwritten by a scanner-derived `working`. `plan` needs the same pin: the
  scanner sees an unresolved `ExitPlanMode` `tool_use` and derives `working`,
  which would flip the card back within 20s. `question` needs **no** pin — the
  scanner independently derives the same `waiting/question`.
- Self-healing is unchanged: once answered, the next `PreToolUse` or `Stop`
  clears the wait, and a missed hook is corrected by the scanner.

`src/ui/Notifier.tsx` widens its `waitingReason` union so a plan block also
raises a desktop alert.

## 6. Section 2 — The pane always says what is blocking

`findPendingQuestion` already walks the transcript accumulating resolved
`tool_use_id`s. That pass is generalised and both consumers share it:

```
findBlockingTool(lines) -> { name, summary } | null
```

the last `tool_use` with no matching `tool_result`, of **any** name, humanized
through the existing `humanizeTool` plus a longer input summary. One addition
covers permission prompts, plan approvals, and any tool added later — no
per-tool code.

`/conversation` returns `blocked` alongside `question`. The pane then always has
something to render:

- `question` present → the existing rich options panel, rendering unchanged.
- otherwise, while `state === "waiting"` → a **BLOCKED** panel: the reason
  ("needs permission" / "plan approval"), the tool and its input
  (`Bash · rm -rf build/`), and `↗ ANSWER IN TERMINAL` wired to the existing
  `focusSession`.

The reason also goes onto the desk card's `doing` line, so a blocked agent can
be triaged from the grid without opening the pane. Concretely: the `PreToolUse`
cases in §5 already set `doing` themselves, and the `Notification` case in
`applyEvent` — which today sets `state`/`waitingReason` but leaves `doing`
untouched, stranding whatever the previous tool was — additionally sets
`doing: "needs permission"`. No new field; the card renders `doing` as it
already does.

## 7. Section 3 — Answering actually lands

New in `ghostty.ts`:

```
answerQuestion(target, answerText) -> ActionResult
  1. send key "escape" to the exact terminal   (cancels the blocked tool)
  2. delay 0.15s  (Esc must be processed before text arrives; `sendPrompt`
                   already uses 0.1s between text and Enter)
  3. input text <answerText> + Enter           (the existing, working path)
```

Precise targets only — tty marker or title, **never** the cwd fallback, matching
`sendPrompt`'s existing rule that input is never sent to a guessed terminal.

The answer is composed as prose, one line per question, so a multi-question ask
is unambiguous:

```
For "Character model": Standalone bodies
For "Roster": Mixed set
```

Composition is a **pure exported function**, unit-tested without driving
AppleScript, exactly as `buildLaunchInput` already is.

`ConversationDrawer` routes both the single-select click and `▸ SEND ANSWER`
through the new `POST /action/answer`. Single-select is broken today in the same
way — it merely fails less visibly — and is fixed by the same change.

### 7.1 The one unverified assumption

This design assumes **Esc cancels a blocked `AskUserQuestion` and returns the
session to its prompt.** That was not confirmable statically: the CLI ships as a
233MB compiled Bun executable and the selector's key bindings are not recoverable
from its strings.

Therefore: **verify against a real session as the first implementation step**,
before any UI is built on top. If Esc behaves otherwise, fall back to the
read-only option — render the question, offer `↗ ANSWER IN TERMINAL` — rather
than ship a path that silently drops answers. Per the project's own debugging
rule: open it and look, do not guess.

## 8. Testing

**Unit (`bun test`), pure:**

| Target | Cases |
| --- | --- |
| `applyEvent` | `PreToolUse` on `AskUserQuestion` → waiting/question; on `ExitPlanMode` → waiting/plan; on `Edit` → working (regression) |
| `findBlockingTool` | unresolved `tool_use` returned; resolved one returns null; newest wins; `AskUserQuestion` still routed to the question panel |
| `mergeForWrite` | a hook-set `plan` survives a scanner-derived `working`; still released by `idle` |
| answer composition | single question; multi-question; multi-select joins |

**Live, once:** a real session, a real `AskUserQuestion`, confirming Esc + prose
lands and the agent proceeds with the right answer. This is the gate on §7.1.

`bunx tsc --noEmit -p tsconfig.json` must stay clean.

## 9. Files touched

| File | Change |
| --- | --- |
| `src/schema.ts` | `waitingReason` gains `"plan"` |
| `hooks/status.ts` | `PreToolUse` special-case |
| `src/scan.ts` | `mergeForWrite` pins `plan` |
| `src/lib/conversation.ts` | `findBlockingTool`, shared resolved-id pass |
| `src/server.ts` | `blocked` on `/conversation`; `POST /action/answer` |
| `src/ghostty.ts` | `answerQuestion` + pure answer composition |
| `src/ui/actions.ts` | client for the new action |
| `src/ui/ConversationDrawer.tsx` | BLOCKED panel; both answer paths rerouted |
| `src/ui/Crew.tsx` | blocked reason on the `doing` line |
| `src/ui/Notifier.tsx` | widened `waitingReason` union |
| `README.md` | the agent pane + controls sections |
