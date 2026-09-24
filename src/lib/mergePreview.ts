// What a MERGE would land: the commits on the card's branch and the files they
// change, read from git before the human presses the key. Pure — git's raw
// output in, a capped, render-ready shape out — so the rules are tested
// without a repo. The server does the reading (see readMergePreview in
// lib/merge) and the card modal only draws the result.

/** Show at most this many commits; the rest are counted, not listed. */
export const MAX_COMMITS = 20;
/** Show at most this many changed files; the rest are counted, not listed. */
export const MAX_FILES = 50;

export type PreviewCommit = { sha: string; subject: string };
export type PreviewFile = {
  path: string;
  /** lines added / removed; null for a binary file (git prints "-") */
  added: number | null;
  removed: number | null;
};

export type MergePreview = {
  branch: string;
  base: string;
  /** the full SHA every list below was read at ("" when there is no branch) */
  tip: string;
  /** the first MAX_COMMITS commits, newest first */
  commits: PreviewCommit[];
  /** all commits on branch that base doesn't have — can exceed commits.length */
  totalCommits: number;
  /** the first MAX_FILES changed files, in git's order */
  files: PreviewFile[];
  /** every changed file, listed or not */
  totalFiles: number;
  /** summed over every changed file, not just the listed ones */
  insertions: number;
  deletions: number;
};

/** `git log --format=%h%x09%s` → commits. A subject may itself hold a tab. */
export function parseCommits(out: string): PreviewCommit[] {
  return out.split("\n").filter((l) => l.trim()).map((line) => {
    const tab = line.indexOf("\t");
    return tab < 0 ? { sha: line.trim(), subject: "" } : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

/** `git diff --numstat` → files. Binary files show "-\t-\tpath". */
export function parseNumstat(out: string): PreviewFile[] {
  const num = (s: string) => (s === "-" ? null : Number.parseInt(s, 10) || 0);
  return out.split("\n").filter((l) => l.trim()).map((line) => {
    const [a = "", r = "", ...rest] = line.split("\t");
    return { path: rest.join("\t"), added: num(a), removed: num(r) };
  });
}

/** Put git's output together into what the card shows, capped. */
export function buildPreview(input: {
  branch: string; base: string; tip?: string; log: string; totalCommits: number; numstat: string;
}): MergePreview {
  const commits = parseCommits(input.log);
  const files = parseNumstat(input.numstat);
  return {
    branch: input.branch,
    base: input.base,
    tip: input.tip ?? "",
    commits: commits.slice(0, MAX_COMMITS),
    totalCommits: Math.max(input.totalCommits, commits.length),
    files: files.slice(0, MAX_FILES),
    totalFiles: files.length,
    insertions: files.reduce((n, f) => n + (f.added ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.removed ?? 0), 0),
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The one line on the block's header: "3 commits · 5 files · +120 −14". */
export function previewSummary(p: MergePreview): string {
  const parts = [plural(p.totalCommits, "commit")];
  if (p.totalFiles > 0) parts.push(plural(p.totalFiles, "file"), `+${p.insertions} −${p.deletions}`);
  return parts.join(" · ");
}

/** The "and N more files" line under a capped list; "" when nothing was cut. */
export function moreLine(shown: number, total: number, noun: string): string {
  return total > shown ? `and ${plural(total - shown, `more ${noun}`)}` : "";
}

/** A file's change, as the diffstat column shows it: "+12 −3", or "binary". */
export function fileChange(f: PreviewFile): string {
  if (f.added === null || f.removed === null) return "binary";
  return `+${f.added} −${f.removed}`;
}

/** Nothing to show: no commits means the block is left out altogether. */
export function isEmptyPreview(p: MergePreview): boolean {
  return p.totalCommits === 0;
}

/** Open by default only while it is short enough to glance at; a long list
 *  starts folded so the MERGE key below it stays in view. */
export function startsOpen(p: MergePreview): boolean {
  return p.totalCommits <= 5 && p.totalFiles <= 8;
}
