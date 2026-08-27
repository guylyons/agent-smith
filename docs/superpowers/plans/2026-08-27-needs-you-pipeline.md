# The Needs-You Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent stops and needs you, the board says so immediately, says what it is stuck on, and lets you unstick it from the web UI.

**Architecture:** Three independent fixes on one pipeline. Detection moves earlier (the `PreToolUse` hook already knows a question is starting — stop discarding that). The pane's renderer becomes generic (one `findBlockingTool` pass replaces per-tool special-casing). Answer delivery stops typing text into a selection widget and instead cancels it with Esc, then uses the plain-prompt path that already works.

**Tech Stack:** Bun · TypeScript · React 19 · Zod · AppleScript (Ghostty)

**Spec:** `docs/superpowers/specs/2026-08-27-needs-you-pipeline-design.md`

## Global Constraints

- macOS + Ghostty only; terminal actions go through Ghostty's AppleScript dictionary.
- Every `ghostty.ts` export resolves to `{ ok, error? }` and **never throws**.
- Input (text, keys) is sent only to a **precisely identified** terminal — tty marker or title. **Never** the cwd fallback; cwd is shared by many tabs.
- No approve/deny of permission prompts from the browser. The pane names the blocked command and hands the user to the terminal.
- `bun test` and `bunx tsc --noEmit -p tsconfig.json` must be clean at every commit.
- `dist/` is build output and untracked. After any `src/ui` change run `bun run build`.
- Pure logic lives in `src/lib/*` and is unit-tested; I/O glue is not unit-tested.

---

### Task 1: Verify the Esc assumption (GATE — blocks Tasks 6–8)

The whole delivery approach rests on one unverified claim: **Esc cancels a blocked `AskUserQuestion` and returns the session to its prompt.** This could not be confirmed statically — the CLI is a 233MB compiled Bun executable and the selector's key bindings are not recoverable from its strings. Verify it against a real session before building anything on it.

**Files:** none (probe only — write no production code in this task)

**Interfaces:**
- Consumes: nothing
- Produces: a go/no-go decision recorded in the plan file

- [ ] **Step 1: Start the dashboard**

```bash
bun run build && bun run dev
```

- [ ] **Step 2: Launch a throwaway agent that will ask a question**

Use **+ NEW AGENT** in the dashboard, pointed at any scratch folder, with the task:

```
Ask me a multiple-choice question with two options using the AskUserQuestion tool, then stop.
```

Wait until its desk card shows it is waiting and the pane renders the options.

- [ ] **Step 3: Find that session's tty**

```bash
cat ~/.agent-status/*.json | python3 -c "import sys,json;[print(json.loads(l).get('sessionId'),json.loads(l).get('tty')) for l in [sys.stdin.read()]]" 2>/dev/null || \
  for f in ~/.agent-status/*.json; do python3 -c "import json,sys;d=json.load(open('$f'));print(d.get('sessionId'),d.get('state'),d.get('tty'))"; done
```

- [ ] **Step 4: Send Esc to that exact terminal and watch it**

Watch the Ghostty tab while running this (substitute the real title):

```bash
osascript -e 'tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with term in terminals of t
        if (name of term) ends with "PUT_THE_TAB_TITLE_HERE" then
          send key "escape" to term
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "no"
end tell'
```

- [ ] **Step 5: Record the observed behaviour**

Answer these three questions by **looking at the terminal**, not by reasoning:

1. Did the option selector close?
2. Did the session return to a normal prompt that accepts typed text?
3. Does the transcript now show a `tool_result` for that `AskUserQuestion` id?

```bash
f=$(ls -t ~/.claude/projects/*/*.jsonl | head -1)
python3 - "$f" <<'PY'
import json,sys
res=set(); asks={}
for l in open(sys.argv[1]):
    l=l.strip()
    if not l: continue
    try: e=json.loads(l)
    except: continue
    for c in (e.get("message") or {}).get("content") or []:
        if not isinstance(c,dict): continue
        if c.get("type")=="tool_result": res.add(c.get("tool_use_id"))
        if c.get("type")=="tool_use" and c.get("name")=="AskUserQuestion": asks[c["id"]]=True
for k in asks:
    print(k, "RESOLVED" if k in res else "STILL PENDING")
PY
```

- [ ] **Step 6: Decide and record**

Edit this plan file, replacing this step's checkbox line with one of:

- `ESC VERIFIED — Tasks 6-8 proceed as written.`
- `ESC REJECTED — <what actually happened>. Tasks 6-8 fall back to read-only: render the question, offer "↗ ANSWER IN TERMINAL" (reuse focusSession), drop composeAnswer/answerQuestion/POST /action/answer.`

```bash
git add docs/superpowers/plans/2026-08-27-needs-you-pipeline.md
git commit -m "docs: record Esc verification result for the needs-you pipeline"
```

---

### Task 2: Instant NEEDS YOU at PreToolUse

`PreToolUse` fires the moment `AskUserQuestion` begins, but `applyEvent` maps every tool to generic `working`, so the board waits up to 20s for the scanner. Also fixes `Notification` leaving `doing` stale — today a permission-blocked agent strands whatever tool it was last running as its activity line.

**Files:**
- Modify: `src/schema.ts:9`
- Modify: `hooks/status.ts:38-56`
- Modify: `src/ui/Notifier.tsx:42`
- Test: `tests/hook-status.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `AgentStatus["waitingReason"]` is now `"permission" | "question" | "plan" | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `tests/hook-status.test.ts`:

```typescript
test("PreToolUse on AskUserQuestion -> waiting/question immediately", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "AskUserQuestion", tool_input: { questions: [] },
  } as any, 2000)!;
  expect(s.state).toBe("waiting");
  expect(s.waitingReason).toBe("question");
  expect(s.doing).toBe("waiting on your answer");
});

test("PreToolUse on ExitPlanMode -> waiting/plan immediately", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "ExitPlanMode", tool_input: {},
  } as any, 2000)!;
  expect(s.state).toBe("waiting");
  expect(s.waitingReason).toBe("plan");
  expect(s.doing).toBe("waiting on plan approval");
});

test("PreToolUse on an ordinary tool is still working (regression)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "Edit", tool_input: { file_path: "/a/card.twig" },
  } as any, 2000)!;
  expect(s.state).toBe("working");
  expect(s.waitingReason).toBeUndefined();
  expect(s.doing).toBe("editing card.twig");
});

test("Notification sets doing, not just state (no stale tool line)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const busy = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "Bash", tool_input: { command: "rm -rf build" },
  } as any, 2000)!;
  const s = applyEvent(busy, {
    hook_event_name: "Notification", session_id: "s1", cwd: "/repo", branch: start.branch,
  } as any, 3000)!;
  expect(s.waitingReason).toBe("permission");
  expect(s.doing).toBe("needs permission");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/hook-status.test.ts`
Expected: FAIL — the two `PreToolUse` cases return `state: "working"`, and `doing` is still `running rm -rf build`.

- [ ] **Step 3: Widen the schema**

In `src/schema.ts`, change line 9 to:

```typescript
  waitingReason: z.enum(["permission", "question", "plan"]).optional(),
```

- [ ] **Step 4: Special-case PreToolUse in the hook**

In `hooks/status.ts`, replace the `PreToolUse` and `Notification` cases in `applyEvent`:

```typescript
    case "PreToolUse": {
      // These tools BLOCK on the user. PreToolUse fires the instant they begin,
      // which is the earliest any signal exists — the transcript scanner would
      // only notice on its next pass, up to 20s later.
      const blocking = e.tool_name === "AskUserQuestion"
        ? { waitingReason: "question" as const, doing: "waiting on your answer" }
        : e.tool_name === "ExitPlanMode"
        ? { waitingReason: "plan" as const, doing: "waiting on plan approval" }
        : null;
      if (blocking) return { ...base, state: "waiting", ...blocking, updatedAt: now };
      return { ...base, state: "working", waitingReason: undefined,
        doing: humanizeTool(e.tool_name ?? "", e.tool_input), updatedAt: now };
    }
    case "Notification":
      // Also set `doing`: without it the card strands the previous tool's line
      // ("running rm -rf build") while the session actually sits on a prompt.
      return { ...base, state: "waiting", waitingReason: "permission",
        doing: "needs permission", updatedAt: now };
```

- [ ] **Step 5: Widen the Notifier union**

In `src/ui/Notifier.tsx` line 42, change the signature to:

```typescript
function notify(name: string, waitingReason: "permission" | "question" | "plan" | undefined, doing: string) {
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `bun test tests/hook-status.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/schema.ts hooks/status.ts src/ui/Notifier.tsx tests/hook-status.test.ts
git commit -m "feat: flag question and plan blocks at PreToolUse, not on the next scan"
```

---

### Task 3: Stop the scanner clobbering a plan block

`mergeForWrite` pins a hook-set `permission` against being overwritten by a scanner-derived `working`. A plan block needs the same pin: the scanner sees an unresolved `ExitPlanMode` `tool_use` and derives `working`, flipping the card back within 20s. `question` needs no pin — the scanner independently derives the same thing.

**Files:**
- Modify: `src/scan.ts:238-252`
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: `waitingReason: "plan"` from Task 2
- Produces: nothing new

- [ ] **Step 1: Write the failing tests**

Append to `tests/scan.test.ts`:

```typescript
test("mergeForWrite: a hook-set plan block survives a scanner-derived working", () => {
  const existing = S({ state: "waiting", waitingReason: "plan", updatedAt: 1000, doing: "waiting on plan approval" });
  const derived = S({ state: "working", waitingReason: undefined, doing: "exitplanmode" });
  const out = mergeForWrite(existing, derived, 5000);
  expect(out.state).toBe("waiting");
  expect(out.waitingReason).toBe("plan");
  expect(out.updatedAt).toBe(5000);
});

test("mergeForWrite: a plan block IS released once the transcript goes idle", () => {
  const existing = S({ state: "waiting", waitingReason: "plan", updatedAt: 1000, doing: "waiting on plan approval" });
  const derived = S({ state: "idle", waitingReason: undefined, doing: "idle", updatedAt: 999_999 });
  const out = mergeForWrite(existing, derived, 5000);
  expect(out.state).toBe("idle");
  expect(out.waitingReason).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/scan.test.ts`
Expected: FAIL on the first — the plan block is not pinned, so `out.state` is `"working"`.

- [ ] **Step 3: Widen the pin**

In `src/scan.ts`, change the pin condition inside `mergeForWrite`:

```typescript
  // A hook-set block on the USER is invisible to the transcript: the session sits
  // on an unresolved tool_use, which derives as "working". Don't let that
  // overwrite it. (`question` is excluded — the scanner derives it independently.)
  if (existing && (existing.waitingReason === "permission" || existing.waitingReason === "plan")) {
    const provenStale = derived.state === "idle" || derived.waitingReason === "question";
    if (!provenStale) return { ...existing, updatedAt: now };
  }
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/scan.test.ts`
Expected: PASS (all existing permission tests still pass — the condition only widened).

- [ ] **Step 5: Commit**

```bash
git add src/scan.ts tests/scan.test.ts
git commit -m "fix: pin a plan block against the scanner's derived working state"
```

---

### Task 4: `findBlockingTool` — one generic pass

`findPendingQuestion` already walks the transcript accumulating resolved `tool_use_id`s. Generalise that walk so the pane can name **any** blocked tool, not just `AskUserQuestion`. This also adds the `isSidechain` skip that `findPendingQuestion` is currently missing.

**Files:**
- Modify: `src/lib/conversation.ts:11-47`
- Test: `tests/conversation.test.ts`

**Interfaces:**
- Consumes: `humanizeTool` from `src/lib/humanize.ts`
- Produces:
  - `export type BlockingTool = { name: string; summary: string }`
  - `export function findBlockingTool(lines: string[]): BlockingTool | null`

- [ ] **Step 1: Write the failing tests**

Append to `tests/conversation.test.ts` (add `findBlockingTool` to the import on line 2):

```typescript
test("findBlockingTool names the last unresolved tool_use", () => {
  const lines = [
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "rm -rf build" } }] } }),
  ];
  expect(findBlockingTool(lines)).toEqual({ name: "Bash", summary: "running rm -rf build" });
});

test("findBlockingTool returns null once the tool resolved", () => {
  const lines = [
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }] } }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } }),
  ];
  expect(findBlockingTool(lines)).toBeNull();
});

test("findBlockingTool reports the NEWEST unresolved tool", () => {
  const lines = [
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a/x.ts" } }] } }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } }),
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_2", name: "ExitPlanMode", input: {} }] } }),
  ];
  expect(findBlockingTool(lines)!.name).toBe("ExitPlanMode");
});

test("findBlockingTool ignores subagent sidechain traffic", () => {
  const lines = [
    L({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", id: "tu_9", name: "Bash", input: { command: "sleep 1" } }] } }),
  ];
  expect(findBlockingTool(lines)).toBeNull();
});

test("findPendingQuestion ignores subagent sidechain traffic", () => {
  const lines = [
    L({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", id: "tu_9", name: "AskUserQuestion", input: { questions: [{ question: "q", options: [{ label: "A" }] }] } }] } }),
  ];
  expect(findPendingQuestion(lines)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/conversation.test.ts`
Expected: FAIL — `findBlockingTool` is not exported; the sidechain question test fails because the skip does not exist yet.

- [ ] **Step 3: Extract the shared walk and add findBlockingTool**

In `src/lib/conversation.ts`, replace `findPendingQuestion` (lines 11-47) with a shared walker plus both consumers:

```typescript
export type BlockingTool = { name: string; summary: string };

type ToolUse = { id: string; name: string; input?: Record<string, unknown> };

/** One pass over the transcript: every tool_use, and the ids that came back.
 *  Sidechain (subagent) and meta entries are skipped — they are not this
 *  session's blocking state. */
function walkTools(lines: string[]): { resolved: Set<string>; uses: ToolUse[] } {
  const resolved = new Set<string>();
  const uses: ToolUse[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain === true || e.isMeta === true) continue;
    for (const c of contentArray(e)) {
      if (c.type === "tool_result" && typeof (c as { tool_use_id?: string }).tool_use_id === "string") {
        resolved.add((c as { tool_use_id: string }).tool_use_id);
      }
      if (c.type === "tool_use" && typeof c.name === "string" && typeof (c as { id?: string }).id === "string") {
        uses.push({ id: (c as { id: string }).id, name: c.name, input: c.input });
      }
    }
  }
  return { resolved, uses };
}

/**
 * Find an AskUserQuestion the session is still waiting on — a tool_use with that
 * name whose tool_use_id has no matching tool_result yet. Lets the dashboard show
 * the options and answer them, instead of forcing the user to the terminal.
 */
export function findPendingQuestion(lines: string[]): PendingQuestion | null {
  const { resolved, uses } = walkTools(lines);
  let last: ToolUse | null = null;
  for (const u of uses) {
    if (u.name !== "AskUserQuestion") continue;
    const qs = (u.input as { questions?: Question[] } | undefined)?.questions;
    if (Array.isArray(qs) && qs.length) last = u;
  }
  if (!last || resolved.has(last.id)) return null;
  const questions = (last.input as { questions: Question[] }).questions;
  return {
    questions: questions.map((q) => ({
      header: q.header, question: q.question, multiSelect: !!q.multiSelect,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
    })),
  };
}

/**
 * The newest tool_use with no tool_result yet — i.e. what the session is sitting
 * on right now. This is how the pane can always name what blocks an agent
 * (a permission prompt, a plan approval, anything future) rather than rendering
 * an empty panel for everything that isn't an AskUserQuestion.
 */
export function findBlockingTool(lines: string[]): BlockingTool | null {
  const { resolved, uses } = walkTools(lines);
  for (let i = uses.length - 1; i >= 0; i--) {
    const u = uses[i];
    if (resolved.has(u.id)) continue;
    return { name: u.name, summary: humanizeTool(u.name, u.input) };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/conversation.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS — including the two pre-existing `findPendingQuestion` tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversation.ts tests/conversation.test.ts
git commit -m "feat: findBlockingTool so the pane can name any blocked tool"
```

---

### Task 5: Serve `blocked` alongside `question`

**Files:**
- Modify: `src/scan.ts:143-159` (`readConversation`)
- Modify: `src/server.ts:100-105`
- Modify: `src/ui/actions.ts` (the `Conversation` type + `fetchConversation`)
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: `findBlockingTool`, `BlockingTool` from Task 4
- Produces: `readConversation()` resolves `{ messages, question, blocked }`; `GET /conversation` returns the same shape; client `Conversation` type gains `blocked: BlockingTool | null`

- [ ] **Step 1: Write the failing test**

Append to `tests/scan.test.ts` (add `readConversation` to the import on line 2):

```typescript
test("readConversation reports the blocking tool", async () => {
  reset();
  const dir = join(projects, "-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sessB.jsonl"), [
    JSON.stringify({ type: "assistant", sessionId: "sessB", cwd: "/repo", message: { content: [{ type: "text", text: "one moment" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "sessB", cwd: "/repo", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "rm -rf build" } }] } }),
  ].join("\n"));
  const conv = await readConversation("sessB");
  expect(conv.question).toBeNull();
  expect(conv.blocked).toEqual({ name: "Bash", summary: "running rm -rf build" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/scan.test.ts`
Expected: FAIL — `conv.blocked` is `undefined`.

- [ ] **Step 3: Return `blocked` from readConversation**

In `src/scan.ts`, update the import on line 17 and the function:

```typescript
import { parseConversation, findPendingQuestion, findBlockingTool, type ChatMessage, type PendingQuestion, type BlockingTool } from "./lib/conversation";
```

```typescript
/** Find a session's transcript and parse it into a chat log, any pending question,
 *  and whatever tool it is currently blocked on. */
export async function readConversation(sessionId: string, maxBytes = 512 * 1024): Promise<{ messages: ChatMessage[]; question: PendingQuestion | null; blocked: BlockingTool | null }> {
  const root = projectsDir();
  let projects: import("node:fs").Dirent[];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return { messages: [], question: null, blocked: null }; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const file = join(root, proj.name, `${sessionId}.jsonl`);
    try {
      const lines = await tailLinesOf(file, maxBytes);
      return { messages: parseConversation(lines), question: findPendingQuestion(lines), blocked: findBlockingTool(lines) };
    } catch { /* not in this project dir */ }
  }
  return { messages: [], question: null, blocked: null };
}
```

- [ ] **Step 4: Update the server's 400 fallback**

In `src/server.ts`, the `/conversation` branch — the error body must match the new shape:

```typescript
        if (!validSessionId(sid)) return json({ messages: [], question: null, blocked: null }, 400);
```

- [ ] **Step 5: Update the client type**

In `src/ui/actions.ts`, add the type and widen `Conversation` + `fetchConversation`:

```typescript
export type BlockingTool = { name: string; summary: string };
export type Conversation = { messages: ChatMessage[]; question: PendingQuestion | null; blocked: BlockingTool | null };
```

```typescript
    const body = (await res.json()) as Partial<Conversation>;
    return { messages: body.messages ?? [], question: body.question ?? null, blocked: body.blocked ?? null };
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add src/scan.ts src/server.ts src/ui/actions.ts tests/scan.test.ts
git commit -m "feat: serve the blocking tool on /conversation"
```

---

### Task 6: Compose the answer prose (pure)

> **Gate:** requires `ESC VERIFIED` from Task 1. If Task 1 recorded `ESC REJECTED`, skip Tasks 6 and 7 and implement only the read-only half of Task 8.

A multi-question ask must read unambiguously as one typed message. This lives in `src/lib/` — not `ghostty.ts` — because **both** the server and the browser need it, and `ghostty.ts` imports node modules the bundle must not pull in.

**Files:**
- Create: `src/lib/answer.ts`
- Test: `tests/answer.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `export function composeAnswer(answers: { label: string; picks: string[] }[]): string`

- [ ] **Step 1: Write the failing test**

Create `tests/answer.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { composeAnswer } from "../src/lib/answer";

test("a single question reads as one labelled line", () => {
  expect(composeAnswer([{ label: "Roster", picks: ["Mixed set"] }]))
    .toBe('For "Roster": Mixed set');
});

test("multiple questions get one line each, in order", () => {
  expect(composeAnswer([
    { label: "Character model", picks: ["Standalone bodies"] },
    { label: "Roster", picks: ["Mixed set"] },
  ])).toBe('For "Character model": Standalone bodies\nFor "Roster": Mixed set');
});

test("a multi-select question joins its picks", () => {
  expect(composeAnswer([{ label: "Targets", picks: ["iOS", "Android"] }]))
    .toBe('For "Targets": iOS, Android');
});

test("questions with no pick are omitted entirely", () => {
  expect(composeAnswer([
    { label: "Answered", picks: ["Yes"] },
    { label: "Skipped", picks: [] },
  ])).toBe('For "Answered": Yes');
});

test("nothing picked at all composes to an empty string", () => {
  expect(composeAnswer([{ label: "Skipped", picks: [] }])).toBe("");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/answer.test.ts`
Expected: FAIL — module `../src/lib/answer` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/answer.ts`:

```typescript
// Compose a picked set of AskUserQuestion answers into one prose message.
// Pure and shared: the browser composes it, the server types it into the
// terminal. Labelled per question so a multi-question ask is unambiguous when
// it arrives as a single typed line.

/** One line per answered question; unanswered questions are dropped. Returns ""
 *  when nothing was picked, which callers treat as "don't send". */
export function composeAnswer(answers: { label: string; picks: string[] }[]): string {
  return answers
    .filter((a) => a.picks.length > 0)
    .map((a) => `For "${a.label}": ${a.picks.join(", ")}`)
    .join("\n");
}
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/answer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/answer.ts tests/answer.test.ts
git commit -m "feat: compose multi-question answers as labelled prose"
```

---

### Task 7: `answerQuestion` — Esc, then the path that works

> **Gate:** requires `ESC VERIFIED` from Task 1.

One AppleScript, not two: Esc and the typed answer must land on the **same** terminal, and two `runOnTerminal` calls could in principle resolve differently.

**Files:**
- Modify: `src/ghostty.ts` (after `sendPrompt`, ~line 113)
- Modify: `src/server.ts` (the `/action/` block, beside `prompt`)
- Modify: `src/ui/actions.ts`

**Interfaces:**
- Consumes: `runOnTerminal`, `asStr`, `Target`, `ActionResult` (all already in `ghostty.ts`)
- Produces:
  - `export async function answerQuestion(t: Target, text: string): Promise<ActionResult>`
  - `POST /action/answer` with body `{ sessionId, text }`
  - client `export function answerQuestion(sessionId: string, text: string): Promise<boolean>`

- [ ] **Step 1: Add answerQuestion to ghostty.ts**

Insert directly after `sendPrompt`:

```typescript
/** Answer a blocked AskUserQuestion. The terminal is showing a SELECTION widget,
 *  which eats typed characters as navigation — so Esc first to cancel it and
 *  return the session to its prompt, then send the answer as ordinary prose down
 *  the path that already works. One script, so both land on the SAME terminal.
 *  Precise targets only (never the cwd fallback), exactly like sendPrompt. */
export async function answerQuestion(t: Target, text: string): Promise<ActionResult> {
  const body = `send key "escape" to term
            delay 0.15
            input text ${asStr(text)} to term
            delay 0.1
            send key "enter" to term`;
  const r = await runOnTerminal(t, body, false);
  if (!r.ok && !t.tty && !t.title) {
    return { ok: false, error: "can't pinpoint this session's terminal — run `bun run install-hooks` to enable answering" };
  }
  return r;
}
```

- [ ] **Step 2: Wire the server action**

In `src/server.ts`, add `answerQuestion` to the `./ghostty` import, then add this branch immediately after the `prompt` branch:

```typescript
        if (action === "answer") {
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim()) return json({ ok: false, error: "empty answer" }, 400);
          if (text.length > 10_000) return json({ ok: false, error: "answer too long" }, 400);
          return json(await answerQuestion(status, text));
        }
```

- [ ] **Step 3: Add the client call**

In `src/ui/actions.ts`, beside `sendPromptTo`:

```typescript
/** Answer a blocked AskUserQuestion. Distinct from sendPromptTo because the
 *  session is sitting in a selection widget, which must be dismissed first. */
export function answerQuestionTo(sessionId: string, text: string): Promise<boolean> {
  return act("answer", { sessionId, text });
}
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/ghostty.ts src/server.ts src/ui/actions.ts
git commit -m "feat: answer a blocked question by cancelling the widget first"
```

---

### Task 8: The pane always has a panel

Two changes in the drawer: route both answer paths through `answerQuestionTo` + `composeAnswer`, and render a BLOCKED panel whenever the agent is waiting on something that is not an `AskUserQuestion`.

Note: `src/ui/Crew.tsx` needs **no** change. The card already renders `a.doing`, and Task 2 made the hook write the right text into it.

**Files:**
- Modify: `src/ui/ConversationDrawer.tsx` (imports; `answer`/`sendAnswer`; the `qpanel` block ~line 300)
- Modify: `README.md` (the *agent pane* section)

**Interfaces:**
- Consumes: `composeAnswer` (Task 6), `answerQuestionTo` + `BlockingTool` (Tasks 5, 7), `focusSession` (existing)
- Produces: nothing downstream

- [ ] **Step 1: Add the blocked state and imports**

In `src/ui/ConversationDrawer.tsx`, add `composeAnswer` to the imports and `blocked` to the action imports/types, then add state beside `question`:

```typescript
import { composeAnswer } from "../lib/answer";
```

```typescript
  const [blocked, setBlocked] = useState<BlockingTool | null>(null);
```

Add `answerQuestionTo` and `type BlockingTool` to the existing `./actions` import list.

- [ ] **Step 2: Track it on the poll**

In the conversation poll effect, beside `setQuestion(conv.question);`:

```typescript
      setBlocked(conv.blocked);
```

- [ ] **Step 3: Route answers through the new action**

Replace `answer` and `sendAnswer`:

```typescript
  async function answer(text: string) {
    if (!text.trim()) return;
    const id = `${Date.now()}-${Math.random()}`;
    const base = messages.filter((msg) => msg.role === "user" && msg.text.trim() === text.trim()).length;
    setPending((p) => [...p, { id, text, base, at: Date.now() }]);
    setQuestion(null); setPicks({});
    atBottomRef.current = true;
    // answerQuestionTo, not sendPromptTo: the session is in a selection widget
    // that must be dismissed before typed text means anything.
    const ok = await answerQuestionTo(agent.sessionId, text);
    if (!ok) setPending((p) => p.filter((x) => x.id !== id));
  }
```

```typescript
  function sendAnswer() {
    const qs = question?.questions ?? [];
    const text = composeAnswer(qs.map((q, qi) => ({
      label: q.header || q.question,
      picks: [...(picks[qi] ?? [])],
    })));
    if (text) void answer(text);
  }
```

- [ ] **Step 4: Make single-select use the same labelled form**

In the `qoptions` map, replace the single-select branch of the click handler:

```typescript
                          onClick={() => (singleQ
                            ? void answer(composeAnswer([{ label: q.header || q.question, picks: [o.label] }]))
                            : togglePick(qi, o.label, q.multiSelect))}
```

- [ ] **Step 5: Render the BLOCKED panel**

Immediately after the closing `)}` of the `{question && ( … )}` block, add:

```tsx
            {!question && blocked && !ended && agent.state === "waiting" && (
              <div className="qpanel">
                <div className="pix qheader">
                  {agent.waitingReason === "plan" ? "PLAN APPROVAL" : "NEEDS PERMISSION"}
                </div>
                <div className="qtext">{blocked.name} · {blocked.summary}</div>
                <button className="deskbtn primary" onClick={() => focusSession(agent.sessionId)}>
                  ↗ ANSWER IN TERMINAL
                </button>
              </div>
            )}
```

- [ ] **Step 6: Build and verify in the real UI**

```bash
bun run build && bun run dev
```

Open the printed URL. With a real agent stopped on a permission prompt, confirm: the desk card reads `NEEDS YOU` with `needs permission`, the pane shows the BLOCKED panel naming the actual command, and `↗ ANSWER IN TERMINAL` jumps to the right Ghostty tab. Then, with a real agent stopped on an `AskUserQuestion`, click an option and confirm the agent proceeds with the answer you picked.

- [ ] **Step 7: Update the README**

In `README.md`, in *The agent pane* section, after the `AskUserQuestion` sentence, add:

```markdown
  When it's blocked on something else — a permission prompt, a plan approval —
  the pane names the exact tool and input it's stuck on (`Bash · rm -rf build/`)
  and offers **↗ ANSWER IN TERMINAL**. Permission prompts are answered in the
  terminal by design: the dashboard is an unauthenticated local page, so it will
  show you the command but never approve it for you.
```

- [ ] **Step 8: Full suite, typecheck, commit**

```bash
bun test && bunx tsc --noEmit -p tsconfig.json
git add src/ui/ConversationDrawer.tsx README.md
git commit -m "feat: pane always names what is blocking an agent"
```

---

## Self-Review

**Spec coverage:** §5 → Task 2 (+ Task 3 for the pin). §6 → Tasks 4, 5, 8. §7 → Tasks 6, 7, 8. §7.1 → Task 1, gating Tasks 6–8. §8 unit tests → Tasks 2–6; §8 live check → Tasks 1 and 8 Step 6. §9 file table → all covered, **except** `src/ui/Crew.tsx`, which the spec listed but which needs no change: the card already renders `a.doing` and Task 2 writes the right text into it. Noted in Task 8.

**Type consistency:** `BlockingTool = { name, summary }` is defined once in Task 4 and re-declared identically for the client in Task 5. `composeAnswer(answers: { label, picks }[])` has the same signature in Tasks 6 and 8. Server export `answerQuestion` (Task 7) is deliberately distinct from client `answerQuestionTo` — same-name imports would collide in `ConversationDrawer`.

**Ordering:** Tasks 2–5 are independent of the Esc gate and can proceed regardless of Task 1's outcome. Only 6–8 depend on it.
