import type { AgentStatus } from "../schema";
import type { Board } from "./board";
import { defaultBoard } from "./board";

// The snapshot the server broadcasts to the browser: the live agents plus the
// kanban board (THE LINE). The board is fully manual — it's read from disk, not
// derived from agent state — so it just rides along here for delivery.
// `boardPath` is where that board lives on disk; the browser can't work out the
// home directory itself, and an assigned agent is told the path so it can move
// its own card and comment on it.
export type Snapshot = { agents: AgentStatus[]; board: Board; boardPath: string };

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
  /** absolute path to the board file, passed through to the browser. */
  boardPath?: string;
};

export function buildSnapshot(agents: AgentStatus[], now: number, opts: BuildOpts = {}): Snapshot {
  const { staleMs = 5 * 60_000, board = defaultBoard(), boardPath = "" } = opts;

  const live = uniquifyNames(
    agents
      .filter((a) => now - a.updatedAt <= staleMs)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  return { agents: live, board, boardPath };
}
