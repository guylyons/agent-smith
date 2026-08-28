# Agent Workshop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Bun + React dashboard that renders live Claude Code session status (written by hooks) as a retro pixel-art "workshop," and the hook script that produces that status.

**Architecture:** A single TypeScript hook script writes one atomic JSON file per session into `~/.agent-status/`. A Bun server watches that dir, validates each file against a shared Zod schema, builds a snapshot, and pushes it to the browser over SSE. A React app ports the mock's visuals and renders the snapshot. Pure derivation/humanization logic lives in `src/lib/` and is unit-tested in isolation.

**Tech Stack:** Bun (runtime, test runner, bundler, server), TypeScript, React 18, Zod. No other runtime deps.

**Spec:** `docs/superpowers/specs/2026-08-26-agent-workshop-design.md`

## Global Constraints

- Runtime is **Bun** — use `Bun.serve`, `bun test`, `bun build`; do not add Node-only deps or a separate bundler.
- Only runtime dependencies allowed: `react`, `react-dom`, `zod`. Everything else is Bun built-in or devDeps (`@types/*`, `typescript`).
- The JSON on-disk shape is defined **once** in `src/schema.ts` and imported by both the hook writer and the server. Never redefine it.
- Three agent states only: `'working' | 'waiting' | 'idle'`. No `'done'`.
- Status dir is `~/.agent-status/` resolved via `os.homedir()` (overridable by env `AGENT_STATUS_DIR` for tests).
- Visual reference of record is `agent_workshop_mockup.html`. Ported sprite/CRT code must match its output.
- TDD: every code file is introduced by a failing `bun test` first. Commit after each task.

---

## File Structure

```
package.json            # scripts, deps
tsconfig.json           # TS config (react-jsx, bundler resolution)
src/
  schema.ts             # AgentStatus + AgentState + Zod schema + parse helper (Task 2)
  lib/
    paths.ts            # statusDir() resolution (Task 1)
    ticket.ts           # parseTicket(branch) (Task 3)
    role.ts             # inferRole(branch, cwd) -> {role,name} (Task 4)
    humanize.ts         # humanizeTool(name, input) -> string (Task 5)
    snapshot.ts         # buildSnapshot(files) -> Snapshot, buildLine (Task 6)
  server.ts             # Bun static + /events SSE + fs.watch (Task 8)
  ui/
    sprite-data.ts      # BASE + GEAR ported from mock (Task 9)
    Sprite.tsx          # sprite renderer (Task 9)
    useSnapshot.ts      # SSE subscription hook (Task 10)
    Crt.tsx             # CRT stack + tube toggle (Task 11)
    Header.tsx Crew.tsx TheLine.tsx  # regions (Task 11)
    App.tsx index.tsx index.html     # app shell (Task 11)
hooks/
  status.ts             # the single hook writer (Task 7)
tests/
  *.test.ts             # colocated per task
```

---

### Task 1: Project scaffold + path resolution

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/lib/paths.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `statusDir(): string` — absolute path to the status dir, honoring `AGENT_STATUS_DIR` else `~/.agent-status`. `ensureStatusDir(): string` — same, but `mkdir -p` first and return it.

- [ ] **Step 1: Init the project**

```bash
cd /Users/guy/github/agent-smith
bun init -y
bun add react react-dom zod
bun add -d @types/react @types/react-dom
```

- [ ] **Step 2: Set `package.json` scripts and `tsconfig.json`**

`package.json` — add scripts (keep the deps bun added):

```json
{
  "type": "module",
  "scripts": {
    "dev": "bun run src/server.ts",
    "build": "bun build src/ui/index.tsx --outdir dist --minify",
    "test": "bun test"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 3: Write the failing test**

```ts
// tests/paths.test.ts
import { test, expect } from "bun:test";
import { statusDir, ensureStatusDir } from "../src/lib/paths";
import { existsSync, rmSync } from "node:fs";

test("statusDir honors AGENT_STATUS_DIR", () => {
  process.env.AGENT_STATUS_DIR = "/tmp/aw-test-dir";
  expect(statusDir()).toBe("/tmp/aw-test-dir");
});

test("ensureStatusDir creates the directory", () => {
  const dir = "/tmp/aw-test-ensure";
  rmSync(dir, { recursive: true, force: true });
  process.env.AGENT_STATUS_DIR = dir;
  expect(ensureStatusDir()).toBe(dir);
  expect(existsSync(dir)).toBe(true);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `bun test tests/paths.test.ts`
Expected: FAIL — cannot find `../src/lib/paths`.

- [ ] **Step 5: Implement**

```ts
// src/lib/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function statusDir(): string {
  return process.env.AGENT_STATUS_DIR ?? join(homedir(), ".agent-status");
}

export function ensureStatusDir(): string {
  const dir = statusDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test tests/paths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git init && git add -A
git commit -m "chore: scaffold agent-workshop + path resolution"
```

---

### Task 2: Shared schema (the contract)

**Files:**
- Create: `src/schema.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - type `AgentState = 'working' | 'waiting' | 'idle'`
  - `interface AgentStatus { sessionId, name, role, ticket: string|null, state: AgentState, waitingReason?: 'permission'|'question', doing: string, cwd: string, branch: string|null, updatedAt: number }`
  - `AgentStatusSchema` (Zod) and `parseStatus(unknown): AgentStatus | null` (returns null on invalid — never throws).

- [ ] **Step 1: Write the failing test**

```ts
// tests/schema.test.ts
import { test, expect } from "bun:test";
import { parseStatus } from "../src/schema";

const valid = {
  sessionId: "abc", name: "FORGE", role: "Component build",
  ticket: "#4412", state: "working", doing: "editing card.twig",
  cwd: "/x", branch: "feature/4412-card", updatedAt: 1,
};

test("parseStatus accepts a valid object", () => {
  expect(parseStatus(valid)?.sessionId).toBe("abc");
});

test("parseStatus returns null on bad state", () => {
  expect(parseStatus({ ...valid, state: "done" })).toBeNull();
});

test("parseStatus returns null on missing field", () => {
  const { doing, ...rest } = valid;
  expect(parseStatus(rest)).toBeNull();
});

test("parseStatus allows null ticket/branch", () => {
  expect(parseStatus({ ...valid, ticket: null, branch: null })).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/schema.test.ts`
Expected: FAIL — cannot find `../src/schema`.

- [ ] **Step 3: Implement**

```ts
// src/schema.ts
import { z } from "zod";

export const AgentStatusSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string(),
  role: z.string(),
  ticket: z.string().nullable(),
  state: z.enum(["working", "waiting", "idle"]),
  waitingReason: z.enum(["permission", "question"]).optional(),
  doing: z.string(),
  cwd: z.string(),
  branch: z.string().nullable(),
  updatedAt: z.number(),
});

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentState = AgentStatus["state"];

export function parseStatus(input: unknown): AgentStatus | null {
  const r = AgentStatusSchema.safeParse(input);
  return r.success ? r.data : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts tests/schema.test.ts
git commit -m "feat: shared AgentStatus schema"
```

---

### Task 3: Ticket parsing

**Files:**
- Create: `src/lib/ticket.ts`
- Test: `tests/ticket.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseTicket(branch: string | null): string | null` — first digit-run as `#NNNN`, else null.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ticket.test.ts
import { test, expect } from "bun:test";
import { parseTicket } from "../src/lib/ticket";

test("extracts number from feature branch", () => {
  expect(parseTicket("feature/4412-card-variant")).toBe("#4412");
});
test("handles bare number", () => {
  expect(parseTicket("4271")).toBe("#4271");
});
test("null branch -> null", () => {
  expect(parseTicket(null)).toBeNull();
});
test("no digits -> null", () => {
  expect(parseTicket("main")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/ticket.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/lib/ticket.ts
export function parseTicket(branch: string | null): string | null {
  if (!branch) return null;
  const m = branch.match(/\d+/);
  return m ? `#${m[0]}` : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/ticket.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ticket.ts tests/ticket.test.ts
git commit -m "feat: parse ticket from branch"
```

---

### Task 4: Role & name inference

**Files:**
- Create: `src/lib/role.ts`
- Test: `tests/role.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `inferRole(branch: string | null, cwd: string): { role: string; name: string }`. Keyword table over `branch + " " + cwd` (lowercased); falls back to `{ role: "General", name: "AGENT" }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/role.test.ts
import { test, expect } from "bun:test";
import { inferRole } from "../src/lib/role";

test("component branch -> build role", () => {
  expect(inferRole("feature/4412-card-component", "/x").role).toBe("Component build");
});
test("docs branch -> docs role", () => {
  expect(inferRole("docs/changelog", "/x").name).toBe("SCRIBE");
});
test("unknown -> General/AGENT", () => {
  expect(inferRole("main", "/x")).toEqual({ role: "General", name: "AGENT" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/role.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/lib/role.ts
interface RoleDef { match: string[]; role: string; name: string; }

const TABLE: RoleDef[] = [
  { match: ["component", "card", "twig", "scss", "theme"], role: "Component build", name: "FORGE" },
  { match: ["doc", "changelog", "readme"], role: "Docs & changelog", name: "SCRIBE" },
  { match: ["test", "profile", "perf", "xhprof"], role: "Test & profile", name: "PROBE" },
  { match: ["migrat", "d10", "d11", "upgrade"], role: "Migration", name: "SHIFT" },
  { match: ["triage", "issue", "scope"], role: "Ticket triage", name: "SCOUT" },
];

export function inferRole(branch: string | null, cwd: string): { role: string; name: string } {
  const hay = `${branch ?? ""} ${cwd}`.toLowerCase();
  for (const d of TABLE) if (d.match.some((k) => hay.includes(k))) return { role: d.role, name: d.name };
  return { role: "General", name: "AGENT" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/role.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/role.ts tests/role.test.ts
git commit -m "feat: infer role and name from work context"
```

---

### Task 5: Tool humanizer

**Files:**
- Create: `src/lib/humanize.ts`
- Test: `tests/humanize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `humanizeTool(name: string, input: Record<string, unknown> | undefined): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/humanize.test.ts
import { test, expect } from "bun:test";
import { humanizeTool } from "../src/lib/humanize";

test("Edit -> editing basename", () => {
  expect(humanizeTool("Edit", { file_path: "/a/b/card.twig" })).toBe("editing card.twig");
});
test("Bash -> running command", () => {
  expect(humanizeTool("Bash", { command: "bun test" })).toBe("running bun test");
});
test("Read -> reading basename", () => {
  expect(humanizeTool("Read", { file_path: "/a/issue.md" })).toBe("reading issue.md");
});
test("unknown tool -> lowercased name", () => {
  expect(humanizeTool("Glob", {})).toBe("glob");
});
test("undefined input -> lowercased name", () => {
  expect(humanizeTool("Edit", undefined)).toBe("edit");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/humanize.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/lib/humanize.ts
function base(p: unknown): string {
  return typeof p === "string" ? p.split("/").pop() || p : "";
}

export function humanizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  switch (name) {
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return i.file_path ? `editing ${base(i.file_path)}` : name.toLowerCase();
    case "Read":
      return i.file_path ? `reading ${base(i.file_path)}` : name.toLowerCase();
    case "Bash":
      return typeof i.command === "string" ? `running ${i.command}` : name.toLowerCase();
    default:
      return name.toLowerCase();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/humanize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/humanize.ts tests/humanize.test.ts
git commit -m "feat: humanize tool activity line"
```

---

### Task 6: Snapshot + line builder

**Files:**
- Create: `src/lib/snapshot.ts`
- Test: `tests/snapshot.test.ts`

**Interfaces:**
- Consumes: `AgentStatus` (Task 2).
- Produces:
  - `type LineStage = { stage: 'backlog'|'working'|'needs'|'review'|'merged'; tickets: string[] }`
  - `type Snapshot = { agents: AgentStatus[]; line: LineStage[] }`
  - `buildSnapshot(agents: AgentStatus[], now: number, staleMs?: number): Snapshot` — drops agents older than `staleMs` (default 5*60_000); sorts agents by name; builds the five-stage line. Placement per ticket: any `waiting` session → `needs`; else any `working` → `working`; else `idle` → `backlog`. `review`/`merged` always empty. Agents with `ticket: null` contribute no crate.

- [ ] **Step 1: Write the failing test**

```ts
// tests/snapshot.test.ts
import { test, expect } from "bun:test";
import { buildSnapshot } from "../src/lib/snapshot";
import type { AgentStatus } from "../src/schema";

const A = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 1000, ...o,
});

test("drops stale agents", () => {
  const snap = buildSnapshot([A({ updatedAt: 0 })], 10 * 60_000);
  expect(snap.agents.length).toBe(0);
});

test("waiting beats working for same ticket", () => {
  const snap = buildSnapshot(
    [A({ sessionId: "1", state: "working", ticket: "#7" }),
     A({ sessionId: "2", state: "waiting", ticket: "#7" })], 1000);
  const needs = snap.line.find((s) => s.stage === "needs")!;
  expect(needs.tickets).toContain("#7");
  expect(snap.line.find((s) => s.stage === "working")!.tickets).not.toContain("#7");
});

test("null ticket contributes no crate", () => {
  const snap = buildSnapshot([A({ ticket: null })], 1000);
  expect(snap.line.every((s) => s.tickets.length === 0)).toBe(true);
});

test("review and merged always present and empty", () => {
  const snap = buildSnapshot([A({})], 1000);
  expect(snap.line.map((s) => s.stage)).toEqual(["backlog","working","needs","review","merged"]);
  expect(snap.line.find((s) => s.stage === "merged")!.tickets).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/snapshot.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/lib/snapshot.ts
import type { AgentStatus } from "../schema";

export type LineStage = {
  stage: "backlog" | "working" | "needs" | "review" | "merged";
  tickets: string[];
};
export type Snapshot = { agents: AgentStatus[]; line: LineStage[] };

export function buildSnapshot(agents: AgentStatus[], now: number, staleMs = 5 * 60_000): Snapshot {
  const live = agents
    .filter((a) => now - a.updatedAt <= staleMs)
    .sort((a, b) => a.name.localeCompare(b.name));

  // best state per ticket: waiting > working > idle
  const rank = { waiting: 3, working: 2, idle: 1 } as const;
  const best = new Map<string, AgentStatus["state"]>();
  for (const a of live) {
    if (!a.ticket) continue;
    const cur = best.get(a.ticket);
    if (!cur || rank[a.state] > rank[cur]) best.set(a.ticket, a.state);
  }

  const stageFor = (s: AgentStatus["state"]) =>
    s === "waiting" ? "needs" : s === "working" ? "working" : "backlog";

  const line: LineStage[] = (["backlog","working","needs","review","merged"] as const)
    .map((stage) => ({ stage, tickets: [] as string[] }));
  const byStage = new Map(line.map((l) => [l.stage, l]));
  for (const [ticket, state] of best) byStage.get(stageFor(state))!.tickets.push(ticket);

  return { agents: live, line };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/snapshot.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/snapshot.ts tests/snapshot.test.ts
git commit -m "feat: build snapshot and kanban line"
```

---

### Task 7: The hook writer

**Files:**
- Create: `hooks/status.ts`
- Test: `tests/hook-status.test.ts`

**Interfaces:**
- Consumes: `AgentStatus` (Task 2), `parseTicket` (Task 3), `inferRole` (Task 4), `humanizeTool` (Task 5), `ensureStatusDir` (Task 1).
- Produces:
  - `applyEvent(prev: AgentStatus | null, event: HookEvent, now: number): AgentStatus | null` — pure reducer; returns the next status, or `null` to signal "delete the file" (SessionEnd).
  - `type HookEvent = { hook_event_name: string; session_id: string; cwd: string; branch: string | null; tool_name?: string; tool_input?: Record<string, unknown>; last_message?: string }`
  - a CLI `main()` that reads a JSON event on stdin, loads/writes/deletes `<session_id>.json` atomically.

  Note: the reducer is pure and unit-tested; `main()` is thin I/O glue. `branch` is passed in the event (the hook shells `git branch --show-current` before invoking, OR the test supplies it) — keep `applyEvent` pure by taking `branch` on the event.

- [ ] **Step 1: Write the failing test (the pure reducer)**

```ts
// tests/hook-status.test.ts
import { test, expect } from "bun:test";
import { applyEvent } from "../hooks/status";

const start = {
  hook_event_name: "SessionStart", session_id: "s1",
  cwd: "/repo", branch: "feature/4412-card-component",
};

test("SessionStart seeds a working agent with ticket+role", () => {
  const s = applyEvent(null, start as any, 1000)!;
  expect(s.state).toBe("working");
  expect(s.ticket).toBe("#4412");
  expect(s.name).toBe("FORGE");
  expect(s.sessionId).toBe("s1");
});

test("PreToolUse updates the doing line", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s1 = applyEvent(s0, {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/repo",
    branch: start.branch, tool_name: "Edit", tool_input: { file_path: "/a/card.twig" },
  } as any, 2000)!;
  expect(s1.doing).toBe("editing card.twig");
  expect(s1.updatedAt).toBe(2000);
});

test("Notification -> waiting/permission", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const s = applyEvent(s0, { hook_event_name: "Notification", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 3000)!;
  expect(s.state).toBe("waiting");
  expect(s.waitingReason).toBe("permission");
});

test("Stop with a question -> waiting/question, else idle", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  const q = applyEvent(s0, { hook_event_name: "Stop", session_id: "s1", cwd: "/repo", branch: start.branch, last_message: "Which variant should I use?" } as any, 4000)!;
  expect(q.state).toBe("waiting");
  expect(q.waitingReason).toBe("question");
  const done = applyEvent(s0, { hook_event_name: "Stop", session_id: "s1", cwd: "/repo", branch: start.branch, last_message: "Done." } as any, 4000)!;
  expect(done.state).toBe("idle");
});

test("SessionEnd -> null (delete)", () => {
  const s0 = applyEvent(null, start as any, 1000)!;
  expect(applyEvent(s0, { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/repo", branch: start.branch } as any, 5000)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/hook-status.test.ts`
Expected: FAIL — cannot find `../hooks/status`.

- [ ] **Step 3: Implement**

```ts
// hooks/status.ts
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import type { AgentStatus } from "../src/schema";
import { parseStatus } from "../src/schema";
import { parseTicket } from "../src/lib/ticket";
import { inferRole } from "../src/lib/role";
import { humanizeTool } from "../src/lib/humanize";
import { ensureStatusDir } from "../src/lib/paths";

export type HookEvent = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  branch: string | null;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  last_message?: string;
};

function seed(e: HookEvent, now: number): AgentStatus {
  const { role, name } = inferRole(e.branch, e.cwd);
  return {
    sessionId: e.session_id, name, role,
    ticket: parseTicket(e.branch), state: "working",
    doing: "starting up", cwd: e.cwd, branch: e.branch, updatedAt: now,
  };
}

const QUESTION = /\?\s*$/;

export function applyEvent(prev: AgentStatus | null, e: HookEvent, now: number): AgentStatus | null {
  const base = prev ?? seed(e, now);
  switch (e.hook_event_name) {
    case "SessionStart":
      return seed(e, now);
    case "PreToolUse":
      return { ...base, state: "working", waitingReason: undefined,
        doing: humanizeTool(e.tool_name ?? "", e.tool_input), updatedAt: now };
    case "Notification":
      return { ...base, state: "waiting", waitingReason: "permission", updatedAt: now };
    case "Stop": {
      const asking = !!e.last_message && QUESTION.test(e.last_message.trim());
      return { ...base, state: asking ? "waiting" : "idle",
        waitingReason: asking ? "question" : undefined, updatedAt: now };
    }
    case "SessionEnd":
      return null;
    default:
      return { ...base, updatedAt: now };
  }
}

// --- I/O glue (not unit-tested; exercised in the integration smoke test) ---
async function main() {
  const raw = await Bun.stdin.text();
  const e = JSON.parse(raw) as HookEvent;
  const dir = ensureStatusDir();
  const file = join(dir, `${e.session_id}.json`);
  const prev = existsSync(file) ? parseStatus(JSON.parse(readFileSync(file, "utf8"))) : null;
  const next = applyEvent(prev, e, Date.now());
  if (next === null) { rmSync(file, { force: true }); return; }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, file); // atomic
}

if (import.meta.main) void main();
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/hook-status.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/status.ts tests/hook-status.test.ts
git commit -m "feat: hook status reducer + writer"
```

---

### Task 8: Bun server — static + SSE watcher

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `parseStatus` (Task 2), `buildSnapshot` (Task 6), `statusDir`/`ensureStatusDir` (Task 1).
- Produces:
  - `readSnapshot(dir: string, now: number): Snapshot` — reads every `*.json`, validates, skips invalid, calls `buildSnapshot`.
  - `makeServer(port: number): Server` — Bun server: `GET /events` (SSE, sends snapshot on connect + on watch change), everything else serves `dist/`. Exposed so the test can start it on an ephemeral port.

- [ ] **Step 1: Write the failing test (the pure reader)**

```ts
// tests/server.test.ts
import { test, expect } from "bun:test";
import { readSnapshot } from "../src/server";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = "/tmp/aw-server-test";

function reset() { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }

const valid = (o: object) => JSON.stringify({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 9_999_999_999_999, ...o,
});

test("readSnapshot includes valid, skips invalid", () => {
  reset();
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", ticket: "#1" }));
  writeFileSync(join(dir, "b.json"), valid({ sessionId: "b", ticket: "#2" }));
  writeFileSync(join(dir, "bad.json"), "{ not json");
  const snap = readSnapshot(dir, Date.now());
  expect(snap.agents.map((a) => a.sessionId).sort()).toEqual(["a", "b"]);
});

test("readSnapshot on empty dir -> empty agents", () => {
  reset();
  expect(readSnapshot(dir, Date.now()).agents).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/server.test.ts`
Expected: FAIL — cannot find `../src/server`.

- [ ] **Step 3: Implement**

```ts
// src/server.ts
import { readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { parseStatus } from "./schema";
import { buildSnapshot, type Snapshot } from "./lib/snapshot";
import { ensureStatusDir, statusDir } from "./lib/paths";

export function readSnapshot(dir: string, now: number): Snapshot {
  const agents = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { /* no dir yet */ }
  for (const f of names) {
    try {
      const s = parseStatus(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (s) agents.push(s);
    } catch { /* half-written; skip */ }
  }
  return buildSnapshot(agents, now);
}

export function makeServer(port: number): Server {
  const dir = ensureStatusDir();
  const clients = new Set<(s: Snapshot) => void>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    const snap = readSnapshot(dir, Date.now());
    for (const send of clients) send(snap);
  };
  watch(dir, () => { if (timer) clearTimeout(timer); timer = setTimeout(push, 150); });

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        let send!: (s: Snapshot) => void;
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            send = (s) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`));
            clients.add(send);
            send(readSnapshot(dir, Date.now())); // initial
          },
          cancel() { clients.delete(send); },
        });
        return new Response(stream, { headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        }});
      }
      // static
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(import.meta.dir, "..", "dist", path));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
  });
}

if (import.meta.main) {
  const server = makeServer(Number(process.env.PORT ?? 4173));
  console.log(`Agent Workshop → http://localhost:${server.port}  (watching ${statusDir()})`);
}
```

- [ ] **Step 4: Run to verify the reader test passes**

Run: `bun test tests/server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add an SSE integration test**

```ts
// append to tests/server.test.ts
test("GET /events streams a snapshot", async () => {
  reset();
  process.env.AGENT_STATUS_DIR = dir;
  writeFileSync(join(dir, "a.json"), valid({ sessionId: "a", ticket: "#9" }));
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const res = await fetch(`http://localhost:${server.port}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text.startsWith("data: ")).toBe(true);
  expect(text).toContain('"#9"');
  await reader.cancel();
  server.stop(true);
});
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test tests/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: bun server with SSE status watcher"
```

---

### Task 9: Sprite renderer (ported from mock)

**Files:**
- Create: `src/ui/sprite-data.ts`, `src/ui/Sprite.tsx`
- Test: `tests/sprite.test.ts`

**Interfaces:**
- Consumes: nothing (self-contained port).
- Produces:
  - `sprite-data.ts`: `BASE: string[]`, `GEAR: Record<string, {at:number;rows:string[]}[]>` — copied verbatim from `agent_workshop_mockup.html`.
  - `spriteRects(opts: { gear: string; palette: SpritePalette }): {x:number;y:number;fill:string}[]` — the pure pixel→rect computation from the mock's `sprite()`, minus the SVG string.
  - `paletteFor(sessionId: string, role: string): { palette: SpritePalette; gear: string }` — deterministic pick from a fixed palette/gear list, indexed by a hash of `sessionId`.
  - `Sprite.tsx`: `<Sprite sessionId role state />` React component rendering the `<svg>` of `<rect>`s, with the mock's `bob` animation when `state==='working'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/sprite.test.ts
import { test, expect } from "bun:test";
import { spriteRects, paletteFor } from "../src/ui/sprite-data";

test("paletteFor is deterministic per sessionId", () => {
  expect(paletteFor("abc", "General")).toEqual(paletteFor("abc", "General"));
});
test("paletteFor returns a palette and a gear", () => {
  const p = paletteFor("aaa", "General");
  expect(typeof p.gear).toBe("string");
  expect(p.palette).toHaveProperty("O");
});
test("spriteRects returns pixels", () => {
  const { palette, gear } = paletteFor("abc", "Component build");
  const rects = spriteRects({ gear, palette });
  expect(rects.length).toBeGreaterThan(50);
  expect(rects[0]).toHaveProperty("fill");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/sprite.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `sprite-data.ts`**

Copy `BASE` and `GEAR` verbatim from `agent_workshop_mockup.html` (lines ~254–332). Then:

```ts
// src/ui/sprite-data.ts  (after the copied BASE and GEAR consts)
export interface SpritePalette { O: string; H: string; B: string; G: string; P: string; }

export function spriteRects({ gear, palette }: { gear: string; palette: SpritePalette }) {
  const pal: Record<string, string> = {
    O: palette.O, H: palette.H, S: "#f0c6a0", s: "#d49f79", E: palette.O,
    W: "#ffffff", B: palette.B, G: palette.G, P: palette.P, F: "#2a2118",
  };
  const grid = BASE.map((r) => [...r]);
  (GEAR[gear] || []).forEach((layer) =>
    layer.rows.forEach((row, i) =>
      [...row].forEach((c, x) => { if (c !== ".") grid[layer.at + i][x] = c; })));
  const rects: { x: number; y: number; fill: string }[] = [];
  grid.forEach((row, y) => row.forEach((c, x) => {
    if (pal[c]) rects.push({ x, y, fill: pal[c] });
  }));
  return rects;
}

const PALETTES: SpritePalette[] = [
  { O: "#101a2e", H: "#3f2b1e", B: "#4a7ec9", G: "#8fc0ff", P: "#26406b" },
  { O: "#2a1410", H: "#7a2f2f", B: "#c9673a", G: "#f2b134", P: "#6e3a22" },
  { O: "#171238", H: "#2b2b3d", B: "#6a5acd", G: "#b7a8ff", P: "#3a3168" },
  { O: "#0e2a20", H: "#4a3a1e", B: "#3f8f6a", G: "#4fbf6a", P: "#245140" },
  { O: "#1d2030", H: "#4a4a4a", B: "#8a8fa8", G: "#d8dcf0", P: "#4c5068" },
];
const GEARS = ["headset", "goggles", "hood", "visor", "topknot"];
const ROLE_GEAR: Record<string, string> = {
  "Ticket triage": "headset", "Component build": "goggles", "Migration": "hood",
  "Test & profile": "visor", "Docs & changelog": "topknot",
};

function hash(s: string): number {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function paletteFor(sessionId: string, role: string) {
  const h = hash(sessionId);
  return { palette: PALETTES[h % PALETTES.length], gear: ROLE_GEAR[role] ?? GEARS[h % GEARS.length] };
}
```

- [ ] **Step 4: Implement `Sprite.tsx`**

```tsx
// src/ui/Sprite.tsx
import { spriteRects, paletteFor } from "./sprite-data";

export function Sprite({ sessionId, role, state }: { sessionId: string; role: string; state: string }) {
  const { palette, gear } = paletteFor(sessionId, role);
  const rects = spriteRects({ gear, palette });
  return (
    <svg className={`sprite ${state === "working" ? "is-bobbing" : ""}`}
         viewBox="0 0 16 24" shapeRendering="crispEdges" aria-hidden="true">
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/sprite.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ui/sprite-data.ts src/ui/Sprite.tsx tests/sprite.test.ts
git commit -m "feat: port sprite renderer from mock"
```

---

### Task 10: SSE subscription hook

**Files:**
- Create: `src/ui/useSnapshot.ts`
- Test: `tests/useSnapshot.test.ts`

**Interfaces:**
- Consumes: `Snapshot` type (Task 6).
- Produces:
  - `emptySnapshot(): Snapshot` — the five empty stages + no agents (used as initial state and by the placement guard).
  - `useSnapshot(): Snapshot` — React hook subscribing to `/events` via `EventSource`, updating state on each message, no-op on parse error.

  Split the parse step into a pure exported `parseEvent(data: string): Snapshot | null` so it can be unit-tested without a DOM.

- [ ] **Step 1: Write the failing test**

```ts
// tests/useSnapshot.test.ts
import { test, expect } from "bun:test";
import { parseEvent, emptySnapshot } from "../src/ui/useSnapshot";

test("emptySnapshot has five stages, no agents", () => {
  const s = emptySnapshot();
  expect(s.agents).toEqual([]);
  expect(s.line.map((l) => l.stage)).toEqual(["backlog","working","needs","review","merged"]);
});
test("parseEvent parses a snapshot", () => {
  const snap = emptySnapshot();
  expect(parseEvent(JSON.stringify(snap))?.agents).toEqual([]);
});
test("parseEvent returns null on garbage", () => {
  expect(parseEvent("{bad")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/useSnapshot.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/ui/useSnapshot.ts
import { useEffect, useState } from "react";
import type { Snapshot, LineStage } from "../lib/snapshot";

export function emptySnapshot(): Snapshot {
  const stages: LineStage["stage"][] = ["backlog","working","needs","review","merged"];
  return { agents: [], line: stages.map((stage) => ({ stage, tickets: [] })) };
}

export function parseEvent(data: string): Snapshot | null {
  try { return JSON.parse(data) as Snapshot; } catch { return null; }
}

export function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(emptySnapshot);
  useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = (e) => { const s = parseEvent(e.data); if (s) setSnap(s); };
    return () => es.close(); // EventSource auto-reconnects while open
  }, []);
  return snap;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/useSnapshot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/useSnapshot.ts tests/useSnapshot.test.ts
git commit -m "feat: SSE snapshot subscription hook"
```

---

### Task 11: React UI shell (regions + styles) and build

**Files:**
- Create: `src/ui/index.html`, `src/ui/index.tsx`, `src/ui/App.tsx`, `src/ui/Crt.tsx`, `src/ui/Header.tsx`, `src/ui/Crew.tsx`, `src/ui/TheLine.tsx`, `src/ui/styles.css`
- Modify: `package.json` (confirm `build` emits `dist/index.html` + assets)

**Interfaces:**
- Consumes: `useSnapshot` (Task 10), `Sprite` (Task 9), `AgentStatus`/`Snapshot` types.
- Produces: a built `dist/` the server serves. No new exports other tasks depend on. This is the terminal integration task — no downstream consumer.

- [ ] **Step 1: Port styles**

Copy the entire `<style>` block from `agent_workshop_mockup.html` into `src/ui/styles.css`. Add one rule for the React sprite bob (the mock animated `.desk.is-working .sprite`; we use a class on the svg):

```css
.sprite.is-bobbing{animation:bob .5s steps(2) infinite}
```

- [ ] **Step 2: `index.html` + `index.tsx`**

```html
<!-- src/ui/index.html -->
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AGENT WORKSHOP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./styles.css">
</head><body><div id="root"></div><script type="module" src="./index.tsx"></script></body></html>
```

```tsx
// src/ui/index.tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 3: Region components**

`Crt.tsx` — the four `.crt-*` divs + the `TUBE` button cycling `''`/`crt-soft`/`crt-off` on `document.documentElement.className` (ported from mock lines ~405–415).

`Header.tsx` — title, `sub`, and the stat line; counts computed from `snapshot.agents` (`working`/`waiting`/`idle`) and open tickets from `snapshot.line` (all stages except `merged`).

`Crew.tsx` — maps `snapshot.agents` to `.desk` articles (mirror mock `drawCrew`), using `<Sprite>`; renders the `!` bubble when `state==='waiting'`, the ticket chip, the `doing` line, and the lamp class from `state`. Idle desks get `is-idle`.

`TheLine.tsx` — maps `snapshot.line` to the five `.stage` columns + crates (mirror mock `drawLine`), then the `.belt`/`.tread`. Crate color: derive from ticket via a small local hash → one of the mock's ownership colors (deterministic, cosmetic).

`App.tsx`:

```tsx
// src/ui/App.tsx
import { useSnapshot } from "./useSnapshot";
import { Crt } from "./Crt";
import { Header } from "./Header";
import { Crew } from "./Crew";
import { TheLine } from "./TheLine";

export function App() {
  const snap = useSnapshot();
  return (
    <>
      <Crt />
      <Header snap={snap} />
      <Crew agents={snap.agents} />
      <TheLine line={snap.line} />
    </>
  );
}
```

- [ ] **Step 4: Build and verify the bundle exists**

Run: `bun run build`
Expected: `dist/index.html` and hashed JS/CSS assets exist. If `bun build` does not copy `index.html`/`styles.css`, add them to the build (e.g. `bun build src/ui/index.html --outdir dist` with Bun's HTML entry support) — confirm `dist/index.html` references the emitted script.

Run: `ls dist`
Expected: `index.html` present.

- [ ] **Step 5: Full test run**

Run: `bun test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/ui package.json
git commit -m "feat: react UI shell ported from mock"
```

---

### Task 12: Wire the hooks into Claude Code + end-to-end verification

**Files:**
- Create: `.claude/settings.json` (hook registration), `README.md` (run + install steps)

**Interfaces:**
- Consumes: `hooks/status.ts` (Task 7), `src/server.ts` (Task 8).
- Produces: a documented, runnable end-to-end setup. Terminal task.

- [ ] **Step 1: Register the hooks**

Create `.claude/settings.json` registering `bun run <abs>/hooks/status.ts` for `SessionStart`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`. The hook reads the event JSON on stdin (Claude Code provides `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`). Because `applyEvent` needs `branch`, wrap the command so it injects the current branch, e.g.:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "b=$(git -C \"$CLAUDE_PROJECT_DIR\" branch --show-current 2>/dev/null); jq --arg b \"$b\" '. + {branch:$b}' | bun run <ABS>/hooks/status.ts" }]}],
    "PreToolUse":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "b=$(git -C \"$CLAUDE_PROJECT_DIR\" branch --show-current 2>/dev/null); jq --arg b \"$b\" '. + {branch:$b}' | bun run <ABS>/hooks/status.ts" }]}],
    "Notification": [{ "hooks": [{ "type": "command", "command": "b=$(git -C \"$CLAUDE_PROJECT_DIR\" branch --show-current 2>/dev/null); jq --arg b \"$b\" '. + {branch:$b}' | bun run <ABS>/hooks/status.ts" }]}],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "b=$(git -C \"$CLAUDE_PROJECT_DIR\" branch --show-current 2>/dev/null); jq --arg b \"$b\" '. + {branch:$b}' | bun run <ABS>/hooks/status.ts" }]}],
    "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "b=$(git -C \"$CLAUDE_PROJECT_DIR\" branch --show-current 2>/dev/null); jq --arg b \"$b\" '. + {branch:$b}' | bun run <ABS>/hooks/status.ts" }]}]
  }
}
```

Replace `<ABS>` with the absolute repo path. (If `jq` is unavailable, document installing it, or have `status.ts` fall back to shelling `git branch --show-current` from `cwd` when `branch` is absent — note this fallback in the README.)

- [ ] **Step 2: Manual hook smoke test**

Run (simulates a SessionStart event):

```bash
echo '{"hook_event_name":"SessionStart","session_id":"smoke1","cwd":"'$PWD'","branch":"feature/4412-card-component"}' | bun run hooks/status.ts
cat ~/.agent-status/smoke1.json
```

Expected: a JSON file with `"name":"FORGE"`, `"ticket":"#4412"`, `"state":"working"`.

- [ ] **Step 3: Start the server and confirm the sprite renders**

Run: `bun run build && bun run dev` (server prints the URL).
Then verify **in a real browser with Claude in Chrome** (per project CLAUDE.md — do not assert from code alone):
- The `smoke1` sprite appears in the crew with ticket `#4412`, gold "working" lamp.
- Feed a waiting event and confirm the `!` bubble + clay lamp appear:
  ```bash
  echo '{"hook_event_name":"Notification","session_id":"smoke1","cwd":"'$PWD'","branch":"feature/4412-card-component"}' | bun run hooks/status.ts
  ```
- Confirm the ticket crate sits in **NEEDS YOU** on THE LINE.
- Feed `SessionEnd` and confirm the sprite leaves.

- [ ] **Step 4: Take a screenshot for the record**

Use Claude in Chrome to capture the dashboard with at least one working and one waiting agent; confirm it matches the mock's layout.

- [ ] **Step 5: Write `README.md`**

Document: what it is, `bun install`, `bun run build`, `bun run dev`, how to install the hooks (copy `.claude/settings.json`, set `<ABS>`), the `AGENT_STATUS_DIR` override, and the v1 limitation that `review`/`merged` stay empty.

- [ ] **Step 6: Commit**

```bash
git add .claude/settings.json README.md
git commit -m "feat: wire hooks + document end-to-end setup"
```

---

## Notes for the executor

- Run `bun test` after every task; the suite must stay green.
- The mock (`agent_workshop_mockup.html`) is the visual source of truth — when porting sprite/CRT/layout code, match its output rather than improvising.
- Do not edit anything under `dist/` — it's build output.
- Keep the JSON shape only in `src/schema.ts`.
