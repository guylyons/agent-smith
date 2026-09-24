// A sandbox dashboard: a copy of the board that can be clicked, written and
// broken without touching anything real. Two things make it isolated, and both
// are needed. The status dir is a temp copy, so board writes land there; and
// the projects dir is an empty temp folder, because the scanner otherwise finds
// every live Claude session in ~/.claude/projects and puts it on the sandbox as
// a desk — where a card move would type into that real terminal. On top of
// that, every terminal action is a no-op, so even a desk that slips in can't
// be typed at, quit or spawned for.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { boardFile } from "./board";
import type { killAgent, sendFreshPrompt, sendPrompt, spawnAgent } from "../ghostty";

type Env = Record<string, string | undefined>;

const same = (a: string, b: string) => resolve(a) === resolve(b);

/** A warning when the status dir has been moved (someone is testing) but the
 *  scanner still reads the real projects dir, so live sessions will show up
 *  on that board and can be typed into. Null when there is nothing to say. */
export function sandboxLeakWarning(env: Env, home: string): string | null {
  const status = env.AGENT_STATUS_DIR;
  if (!status || same(status, join(home, ".agent-status"))) return null;
  const realProjects = join(home, ".claude", "projects");
  const projects = env.AGENT_PROJECTS_DIR ?? realProjects;
  if (!same(projects, realProjects)) return null;
  return `WARNING: AGENT_STATUS_DIR is ${status}, but the scanner still reads ${realProjects}. ` +
    `Live Claude sessions will appear here and board events will be typed into their terminals. ` +
    `Set AGENT_PROJECTS_DIR to an empty folder too, or use \`bun run sandbox\`.`;
}

const refuse = async () => ({ ok: false, error: "sandbox" });

/** makeServer's terminal hooks, all refused: nothing a sandbox does reaches a
 *  real terminal. */
export const sandboxOps: {
  deliver: typeof sendPrompt; deliverFresh: typeof sendFreshPrompt; spawn: typeof spawnAgent; quit: typeof killAgent;
} = { deliver: refuse, deliverFresh: refuse, spawn: refuse, quit: refuse };

/** Make a fresh sandbox under `root`: a status dir holding a copy of the live
 *  board (only the board — the live desks' status files stay behind) and an
 *  empty projects dir. Returns the env that points a server at them. */
export function prepareSandbox(liveStatusDir: string, root: string): { AGENT_STATUS_DIR: string; AGENT_PROJECTS_DIR: string } {
  mkdirSync(root, { recursive: true });
  const base = mkdtempSync(join(root, "sandbox-"));
  const status = join(base, "status");
  const projects = join(base, "projects");
  mkdirSync(status);
  mkdirSync(projects);
  const board = boardFile(liveStatusDir);
  if (existsSync(board)) copyFileSync(board, boardFile(status));
  return { AGENT_STATUS_DIR: status, AGENT_PROJECTS_DIR: projects };
}
