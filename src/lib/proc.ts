// Deciding whether a pid is (still) a Claude Code session, from the `comm` that
// `ps` reports. Two different questions, deliberately two different rules:
//
//  - DISCOVERY (isClaudeComm): we're scanning every process on the machine to
//    find sessions. Only an actual `claude` binary counts. A shim install runs
//    under `node`/`bun`, and accepting those here would count every unrelated
//    node process on the box as a session.
//  - LIVENESS (isSessionHostComm): we already know this pid WAS a session (a
//    hook recorded it from its own parent). The question is only whether that
//    process is still there, so shim hosts count — while an obviously unrelated
//    process still reads as "gone", catching a recycled pid.
//
// `comm` may be a bare name or a full path depending on how the process was
// exec'd — /Users/you/.local/bin/claude and claude are the same program.

/** Basename of a `ps -o comm=` value: "/usr/local/bin/claude" -> "claude". */
export function commName(comm: string): string {
  const t = comm.trim();
  return t.split("/").pop() || t;
}

/** Is this process a `claude` CLI? Used when scanning ALL processes. */
export function isClaudeComm(comm: string): boolean {
  return commName(comm) === "claude";
}

/** Could this process still be hosting a session we already know the pid of?
 *  Wider than isClaudeComm (shim installs run under node/bun/deno) but still
 *  narrow enough to reject a pid the OS has since recycled. */
const SESSION_HOSTS = new Set(["claude", "node", "bun", "deno"]);
export function isSessionHostComm(comm: string): boolean {
  return SESSION_HOSTS.has(commName(comm));
}

/**
 * Is `pid` still the session it was recorded as? `procs` is a pid -> comm table
 * from a single `ps` pass.
 *
 * Returns null when we cannot tell — an empty table means `ps` gave us nothing
 * usable, and a status file must never be deleted on that guess. Callers treat
 * null as "keep".
 */
export function pidIsLiveSession(pid: number, procs: Map<number, string>): boolean | null {
  if (procs.size === 0) return null; // no usable process table -> don't judge
  const comm = procs.get(pid);
  if (comm === undefined) return false; // process is gone
  return isSessionHostComm(comm); // present, but is it still OUR process?
}
