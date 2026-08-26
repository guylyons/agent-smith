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
  // Set by the hook (not the transcript scanner) so the dashboard can act on the
  // real session: pid = the Claude process to signal; tty = its terminal device.
  pid: z.number().optional(),
  tty: z.string().optional(),
  // Claude Code's task title (aiTitle), which equals the Ghostty tab title — used
  // to focus the exact terminal without needing the tty.
  title: z.string().optional(),
  // count of subagents (Task tool) currently active inside this session
  subagents: z.number().optional(),
});

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentState = AgentStatus["state"];

export function parseStatus(input: unknown): AgentStatus | null {
  const r = AgentStatusSchema.safeParse(input);
  return r.success ? r.data : null;
}
