// Rebuilding the dashboard's own UI after a MERGE lands a UI change. The server
// serves dist/, which only `bun run build` writes, so without this a merged UI
// fix stays invisible until someone builds by hand — and looks like it failed.
//
// Safety first: the build goes to a scratch folder, and only a build that
// finished and produced an index.html is copied into dist/. Files are renamed
// into place one by one with index.html LAST, so a page load mid-copy gets the
// old index (whose chunks are still there) or the new one (whose chunks
// already are). Old chunks are left behind, as `bun run build` leaves them, so
// a tab still on the old build can lazy-load what it needs until it reloads.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runExclusive } from "./merge-queue";
import { repoRoot } from "./merge";

export type BuildResult = { ok: boolean; error?: string };
/** Builds the UI of the checkout at `cwd` into the empty folder `outdir`. */
export type Builder = (cwd: string, outdir: string) => Promise<BuildResult>;

/** Does a merge that changed `files` (repo-relative paths) change the UI?
 *  The bundle imports src/lib and more besides src/ui, and the build reads
 *  the deps, so anything under src/ or the package files counts. */
export function touchesUi(files: string[]): boolean {
  return files.some((f) => f.startsWith("src/") || f === "package.json" || f === "bun.lock");
}

/** A short id for the build in `distDir`: a hash of its index.html, which
 *  names every hashed chunk, so any change to the bundle changes it. "" when
 *  nothing is built. */
export function uiVersion(distDir: string): string {
  try {
    return createHash("sha1").update(readFileSync(join(distDir, "index.html"))).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

/** The last few lines a failed build printed: short enough for a toast. A
 *  leading "^" (bun's pointer under the bad spot, whose source line didn't
 *  make the cut) means nothing on its own, so it goes. */
function why(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3);
  while (lines.length && /^[\^~\s]+$/.test(lines[0]!)) lines.shift();
  const text = lines.join(" ").slice(0, 300);
  return text || "the build failed with no output";
}

/** `bun run build`, pointed at `outdir` (keep in step with package.json). */
export const bunBuild: Builder = async (cwd, outdir) => {
  try {
    const p = Bun.spawn([process.execPath, "build", "src/ui/index.html", "--outdir", outdir, "--minify"], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if ((await p.exited) === 0) return { ok: true };
    return { ok: false, error: why(`${stdout}\n${stderr}`) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? join(rel, n) : n;
    return statSync(join(dir, r)).isDirectory() ? filesUnder(dir, r) : [r];
  });
}

/** Copy one file into dist under a temp name, then rename: never half-written. */
function place(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = `${to}.incoming-${process.pid}`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

/**
 * Build the UI of the checkout at `root` and swap it into `distDir`. On any
 * failure dist/ is left exactly as it was and the reason comes back. Never
 * throws.
 */
export async function rebuildUi(root: string, distDir: string, build: Builder = bunBuild): Promise<BuildResult> {
  let stage = "";
  try {
    stage = mkdtempSync(join(tmpdir(), "ui-build-"));
    const r = await build(root, stage).catch((e): BuildResult => ({ ok: false, error: String(e) }));
    if (!r.ok) return { ok: false, error: r.error || "the build failed" };
    if (!existsSync(join(stage, "index.html"))) return { ok: false, error: "the build wrote no index.html" };
    const files = filesUnder(stage).filter((f) => f !== "index.html");
    for (const f of files) place(join(stage, f), join(distDir, f));
    place(join(stage, "index.html"), join(distDir, "index.html"));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not update ${distDir}: ${String(e)}` };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(p.stdout).text();
    return { code: await p.exited, stdout: stdout.trim() };
  } catch {
    return { code: 1, stdout: "" };
  }
}

export type RebuildResult = { ran: false } | { ran: true; ok: boolean; error?: string };

/**
 * After MERGE made `commit`: rebuild the UI in `distDir` when that is the
 * checkout the merge landed in (its HEAD has the commit — so not another
 * repo, a worktree on some other branch, or a detached jj checkout whose files
 * haven't moved) and the merge changed what the UI is built from (touchesUi). Runs in the
 * repo's merge queue, so no merge moves the files mid-build. Never throws.
 */
export async function rebuildAfterMerge(distDir: string, commit: string, build: Builder = bunBuild): Promise<RebuildResult> {
  if (!commit) return { ran: false };
  const checkout = dirname(distDir);
  const root = await repoRoot(checkout);
  if (!root) return { ran: false };
  return runExclusive(root, async (): Promise<RebuildResult> => {
    if ((await git(checkout, ["merge-base", "--is-ancestor", commit, "HEAD"])).code !== 0) return { ran: false };
    // A MERGE commit's first parent is the trunk before it, so this is what the merge brought in.
    const diff = await git(checkout, ["diff", "--name-only", `${commit}^1`, commit]);
    if (diff.code !== 0 || !touchesUi(diff.stdout.split("\n"))) return { ran: false };
    return { ran: true, ...(await rebuildUi(checkout, distDir, build)) };
  });
}
