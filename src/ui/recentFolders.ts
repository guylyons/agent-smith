// The repo folders offered as one-click buttons in the New Agent dialog.
//
// These used to be derived purely from the folders live agents happened to be
// running in, so the list emptied the moment your agents did — the folder you
// used yesterday was gone and had to be typed out again. Now a launch is
// remembered, and the live folders are merged on top so a session someone else
// started still shows up.
//
// The list ops are pure (and unit-tested); only the two thin wrappers touch
// localStorage, which can throw or hold anything at all, so both are defensive.
import { KEYS, loadSetting, saveSetting } from "./settings";

/** How many buttons the dialog will show. Enough to cover the repos you move
 *  between, few enough that the row doesn't wrap into a wall. */
export const MAX_RECENT = 8;

/** Most-recent-first, `folder` moved (not duplicated) to the front, capped.
 *  A worktree launch is remembered as its repo: the worktree is another
 *  agent's branch and goes away when that agent's work lands. */
export function pushRecent(list: string[], folder: string, max = MAX_RECENT): string[] {
  const f = worktreeRoot(folder.trim());
  if (!f) return list.slice(0, max);
  return [...new Set([f, ...list.map(worktreeRoot)])].filter(Boolean).slice(0, max);
}

/** Remembered folders first (that's the history the user built), then whatever
 *  live agents are running in, each as its repo root (an agent in a worktree
 *  would otherwise add a chip per worktree), de-duped and capped. */
export function mergeRecent(stored: string[], live: string[], max = MAX_RECENT): string[] {
  return [...new Set([...stored, ...live].map(worktreeRoot))].filter(Boolean).slice(0, max);
}

/** Coerce whatever came back out of storage into a clean string list — a hand
 *  edit, a half-written value or an older shape must degrade to "no history",
 *  never to a crash on open. */
export function parseRecent(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    // Older builds saved agents' worktree folders; show those as their repo.
    const paths = v.filter((p): p is string => typeof p === "string" && !!p.trim()).map(worktreeRoot);
    return [...new Set(paths)].filter(Boolean).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** The project a live agent's folder belongs to: an agent in a worktree runs
 *  in <repo>/.claude/worktrees/<name> (or a folder inside it), and the project
 *  is the <repo>. Trailing slashes go, so "/a/b/" and "/a/b" are one folder;
 *  a bare root ("/") is kept. */
export function worktreeRoot(folder: string): string {
  const f = folder.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/, "");
  return f.replace(/(.)[\\/]+$/, "$1");
}

/** The one folder to call "the current project": the most recent launch, else
 *  the first live agent's, as its repo root (a launch can be into a worktree
 *  too), or "" when there is nothing to go on. */
export function projectFolder(stored: string[], live: string[]): string {
  return [...stored, ...live].map(worktreeRoot).find(Boolean) ?? "";
}

export function loadRecentFolders(): string[] {
  return parseRecent(loadSetting(KEYS.recentFolders, "[]"));
}

/** Persist and return the new list. Callers use the return value rather than
 *  re-reading, so the UI updates even if the write itself failed. */
export function saveRecentFolders(list: string[]): string[] {
  saveSetting(KEYS.recentFolders, JSON.stringify(list));
  return list;
}
