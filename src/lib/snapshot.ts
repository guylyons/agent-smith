import type { AgentStatus } from "../schema";

export type LineStage = {
  stage: "backlog" | "working" | "needs" | "review" | "merged";
  tickets: string[]; // work labels: a ticket (#123), else a short branch / repo
};
export type Snapshot = { agents: AgentStatus[]; line: LineStage[] };

const rank = { waiting: 3, working: 2, idle: 1 } as const;

function repoTail(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "?";
}

function shortBranch(branch: string | null): string | null {
  if (!branch) return null;
  if (branch === "HEAD" || branch === "main" || branch === "master") return null;
  const tail = branch.split("/").pop() || branch;
  return tail.length > 18 ? tail.slice(0, 17) + "…" : tail;
}

/** What a session's crate is labelled by on THE LINE: ticket if it has one, else a
 *  short branch name, else the repo — so ticketless work still shows up. */
export function workLabel(a: AgentStatus): string {
  return a.ticket ?? shortBranch(a.branch) ?? repoTail(a.cwd);
}

/** Two sessions can hash to the same codename; make names unique within the view
 *  by suffixing a stable fragment of the session id. Never mutates the inputs. */
function uniquifyNames(agents: AgentStatus[]): AgentStatus[] {
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  return agents.map((a) =>
    (counts.get(a.name) ?? 0) > 1 ? { ...a, name: `${a.name} ${a.sessionId.slice(0, 4)}` } : a,
  );
}

export function buildSnapshot(agents: AgentStatus[], now: number, staleMs = 5 * 60_000): Snapshot {
  const live = uniquifyNames(
    agents
      .filter((a) => now - a.updatedAt <= staleMs)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  // Best state per work item, keyed by repo+label so the SAME ticket number in
  // two different repos stays two separate crates (waiting > working > idle).
  const best = new Map<string, { state: AgentStatus["state"]; label: string }>();
  for (const a of live) {
    const label = workLabel(a);
    const key = `${repoTail(a.cwd)}|${label}`;
    const cur = best.get(key);
    if (!cur || rank[a.state] > rank[cur.state]) best.set(key, { state: a.state, label });
  }

  const stageFor = (s: AgentStatus["state"]) =>
    s === "waiting" ? "needs" : s === "working" ? "working" : "backlog";

  const line: LineStage[] = (["backlog", "working", "needs", "review", "merged"] as const)
    .map((stage) => ({ stage, tickets: [] as string[] }));
  const byStage = new Map(line.map((l) => [l.stage, l]));
  for (const { state, label } of best.values()) byStage.get(stageFor(state))!.tickets.push(label);
  for (const l of line) l.tickets.sort();

  return { agents: live, line };
}
