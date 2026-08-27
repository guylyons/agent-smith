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
  // user-chosen sprite override (palette index + gear id + character body),
  // replacing the deterministic default derived from sessionId+role
  sprite: z.object({ palette: z.number(), gear: z.string(), body: z.string().optional() }).optional(),
});

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export function parseStatus(input: unknown): AgentStatus | null {
  const r = AgentStatusSchema.safeParse(input);
  return r.success ? r.data : null;
}
