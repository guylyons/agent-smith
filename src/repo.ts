// Read git context for a session's working directory (branch, recent commits,
// working-tree status), for the dashboard's INFO tab. Best-effort: a non-git dir
// or missing git yields empty fields, never throws.
export type Commit = { hash: string; subject: string };
export type RepoInfo = {
  cwd: string;
  branch: string;
  commits: Commit[];
  status: { code: string; file: string }[];
};

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } catch {
    return "";
  }
}

export async function readRepo(cwd: string): Promise<RepoInfo> {
  if (!cwd) return { cwd, branch: "", commits: [], status: [] };
  const [branch, log, status] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["log", "--oneline", "--no-color", "-20"]),
    git(cwd, ["status", "--short"]),
  ]);
  const commits: Commit[] = log.trim().split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return i < 0 ? { hash: l, subject: "" } : { hash: l.slice(0, i), subject: l.slice(i + 1) };
  });
  const st = status.replace(/\r/g, "").split("\n").filter(Boolean).map((l) => ({
    code: l.slice(0, 2).trim(),
    file: l.slice(3),
  }));
  return { cwd, branch: branch.trim(), commits, status: st };
}
