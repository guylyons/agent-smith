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
