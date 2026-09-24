import type { AgentStatus } from "../schema";
import type { Board } from "./board";
import { defaultBoard } from "./board";
import type { Mood } from "./mood";
import { displayState } from "./liveness";

// The snapshot the server broadcasts to the browser: the live agents plus the
// kanban board (THE LINE). The board is fully manual — it's read from disk, not
// derived from agent state — so it just rides along here for delivery, and so
// does the MOOD board (the server adds it; see readSnapshot). An agent that
// needs either fetches GET /board or GET /mood itself.
export type Snapshot = { agents: AgentStatus[]; board: Board; mood?: Mood };

/** Collapse the /clear ghost: a /clear starts a NEW session id in the SAME
 *  process without firing SessionEnd, so the old session's status file lingers
 *  (its pid is still the live claude, so the scanner's pid-prune won't delete
 *  it, and it sits on the board as a duplicate desk until it ages out). Both
 *  files carry the crew id that outlives the /clear, so keep only the freshest
 *  per crew. Agents without a crew id are left untouched. Never mutates inputs. */
function dedupeByCrew(agents: AgentStatus[]): AgentStatus[] {
  const freshest = new Map<string, AgentStatus>();
  const out: AgentStatus[] = [];
  for (const a of agents) {
    const crewId = a.crew?.id;
    if (!crewId) { out.push(a); continue; }
    const seen = freshest.get(crewId);
    if (!seen || a.updatedAt > seen.updatedAt) freshest.set(crewId, a);
  }
  return [...out, ...freshest.values()];
}

/** Show the state we actually believe: a "working" stamp nothing has refreshed
 *  inside the liveness window is a session that died mid-turn (crash, force
 *  quit, a Stop that never returned), so it reads as idle — otherwise its desk
 *  keeps a bobbing WORKING sprite for the full five-minute existence window.
 *  Only flips working->idle; every other state is left as-is. Never mutates. */
function withDisplayState(agents: AgentStatus[], now: number): AgentStatus[] {
  return agents.map((a) => {
    const shown = displayState(a, now);
    if (shown === a.state) return a;
    return { ...a, state: shown, doing: "idle" };
  });
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
  /** the kanban board to carry in the snapshot (read from disk by the server). */
  board?: Board;
};

export function buildSnapshot(agents: AgentStatus[], now: number, opts: BuildOpts = {}): Snapshot {
  const { staleMs = 5 * 60_000, board = defaultBoard() } = opts;

  const live = uniquifyNames(
    withDisplayState(
      dedupeByCrew(agents.filter((a) => now - a.updatedAt <= staleMs)),
      now,
    ).sort((a, b) => a.name.localeCompare(b.name)),
  );

  return { agents: live, board };
}
