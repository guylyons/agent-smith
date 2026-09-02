import { z } from "zod";

export const AgentStatusSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string(),
  role: z.string(),
  ticket: z.string().nullable(),
  state: z.enum(["working", "waiting", "idle"]),
  waitingReason: z.enum(["permission", "question", "plan"]).optional(),
  // The questions+options of an AskUserQuestion the session is BLOCKED on, captured
  // by the hook from PreToolUse.tool_input. This is the only live source: Claude Code
  // does NOT flush a pending AskUserQuestion to the transcript — the entry appears
  // only once answered, backdated to its creation time — so the transcript scanner
  // can never see a question while it actually blocks. Cleared when the wait ends.
  pendingQuestion: z.object({
    questions: z.array(z.object({
      header: z.string().optional(),
      question: z.string(),
      multiSelect: z.boolean().optional(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    })),
  }).optional(),
  doing: z.string(),
  cwd: z.string(),
  branch: z.string().nullable(),
  updatedAt: z.number(),
  // When the session entered its current `state` (Unix ms) — set by the hook on
  // each state transition and carried across scanner rewrites, so the grid can
  // show "WORKING · 6m" and dim a desk that's been idle for an hour.
  stateSince: z.number().optional(),
  // Set by the hook (not the transcript scanner) so the dashboard can act on the
  // real session: pid = the Claude process to signal; tty = its terminal device.
  pid: z.number().optional(),
  tty: z.string().optional(),
  // Claude Code's task title (aiTitle), which equals the Ghostty tab title — used
  // to focus the exact terminal without needing the tty.
  title: z.string().optional(),
  // count of subagents (Task tool) currently active inside this session
  subagents: z.number().optional(),
  // persona id (see personas/*.md), captured by the hook from AGENT_PERSONA at
  // launch. Only the id is stored — name/role/sprite resolve from the registry
  // at snapshot time, so editing a persona file updates live desks.
  persona: z.string().optional(),
  // crew member (see src/lib/crew.ts): the identity that outlives the session
  // id. Set by the hook from AGENT_CREW/AGENT_NAME (a dashboard spawn) or from
  // the claude pid (a session started by hand); carried across every event and
  // scanner pass, so a /clear keeps the desk's name, its cards and its notes.
  crew: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
  // user-chosen sprite override (palette index + gear id + character body),
  // replacing the deterministic default derived from sessionId+role
  sprite: z.object({ palette: z.number(), gear: z.string(), body: z.string().optional() }).optional(),
  // Claude token budget, set by the scanner from the transcript's
  // "<total_tokens>N tokens left</total_tokens>" markers: budgetLeft is the
  // newest marker (tail), budgetTotal the session's first (head) — absent when
  // the head is unreadable. Sessions without markers carry no usage at all.
  // Feeds the header's usage meter.
  usage: z.object({ budgetLeft: z.number(), budgetTotal: z.number().optional() }).optional(),
  // Board notifications waiting for this session's turn to end (see the
  // server's inbox). Decorated onto the snapshot by the server; never persisted.
  inbox: z.number().optional(),
});

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export function parseStatus(input: unknown): AgentStatus | null {
  const r = AgentStatusSchema.safeParse(input);
  return r.success ? r.data : null;
}
