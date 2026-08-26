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
