import type { AgentStatus } from "../schema";
import type { LineState } from "./line-state";

export type LineStageName = "backlog" | "working" | "needs" | "done" | "review" | "merged";
// A crate on THE LINE. `key` (repo|label) is its stable identity across sessions —
// what the client sends back to designate it review/merged. `sessionId` is the
// last-known session behind it, for click-through to its conversation.
export type LineItem = { key: string; label: string; sessionId?: string; stage: LineStageName };
export type LineStage = { stage: LineStageName; items: LineItem[] };
export type Snapshot = { agents: AgentStatus[]; line: LineStage[] };

export const LINE_STAGES: LineStageName[] = ["backlog", "working", "needs", "done", "review", "merged"];

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

/** Stable identity for a crate: repo + label, so the SAME ticket number in two
 *  repos stays two crates and a designation keys to the right one. */
export function itemKey(cwd: string, label: string): string {
  return `${repoTail(cwd)}|${label}`;
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

export type BuildOpts = {
  staleMs?: number;
  /** cwds with committed-but-unpushed work — an idle session here lands in DONE. */
  committedCwds?: Set<string>;
  /** your review/merged moves, keyed by item key — these win over the live stage. */
  designations?: LineState;
};

export function buildSnapshot(agents: AgentStatus[], now: number, opts: BuildOpts = {}): Snapshot {
  const { staleMs = 5 * 60_000, committedCwds = new Set<string>(), designations = {} } = opts;

  const live = uniquifyNames(
    agents
      .filter((a) => now - a.updatedAt <= staleMs)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  // Best state per work item, keyed by repo+label (waiting > working > idle).
  type Best = { state: AgentStatus["state"]; label: string; sessionId: string; cwd: string };
  const best = new Map<string, Best>();
  for (const a of live) {
    const label = workLabel(a);
    const key = itemKey(a.cwd, label);
    const cur = best.get(key);
    if (!cur || rank[a.state] > rank[cur.state]) best.set(key, { state: a.state, label, sessionId: a.sessionId, cwd: a.cwd });
  }

  const line: LineStage[] = LINE_STAGES.map((stage) => ({ stage, items: [] as LineItem[] }));
  const byStage = new Map(line.map((l) => [l.stage, l]));

  const stageFor = (b: Best): LineStageName =>
    b.state === "waiting" ? "needs"
    : b.state === "working" ? "working"
    : committedCwds.has(b.cwd) ? "done" // idle: committed-but-unpushed vs not-begun
    : "backlog";

  for (const [key, b] of best) {
    // A user designation (review/merged) always wins over the derived stage.
    const stage = designations[key]?.stage ?? stageFor(b);
    byStage.get(stage)!.items.push({ key, label: b.label, sessionId: b.sessionId, stage });
  }

  // Designated items whose session has ended still deserve a crate — render them
  // from the stored designation so review/merged work doesn't vanish.
  for (const [key, d] of Object.entries(designations)) {
    if (best.has(key)) continue;
    byStage.get(d.stage)!.items.push({ key, label: d.label, sessionId: d.sessionId, stage: d.stage });
  }

  for (const l of line) l.items.sort((a, b) => a.label.localeCompare(b.label));

  return { agents: live, line };
}
