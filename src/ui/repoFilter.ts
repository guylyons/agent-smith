// A card's repo is typed by hand, so the same project gets spelled several ways
// ("tubetable", "~/github/tubetable") and anything that matches repos exactly —
// the scrum master's notices, the board's repo filter — misses half of them.
// These are the pure pieces: tidy what was typed into a repo name (+ path), list
// the repos the board already knows about, and pick one project's cards out of
// the board. Only the two thin storage wrappers touch localStorage.
import type { AgentStatus } from "../schema";
import { repoName, type Board, type Card } from "../lib/board";
import { worktreeRoot } from "./recentFolders";
import { KEYS, loadSetting, saveSetting } from "./settings";

export type KnownRepo = { name: string; path?: string };
export type RepoFilter = { kind: "all" } | { kind: "none" } | { kind: "repo"; repo: string };

const looksLikePath = (s: string) => /[\\/]/.test(s) || s.startsWith("~");
const isAbsolute = (s: string) => s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s);

/** The repo a card's label names: a path counts as its folder (a worktree as
 *  its repo), so old cards saved as "~/github/tubetable" still group right. */
export function repoKey(repo: string | undefined): string {
  const r = (repo ?? "").trim();
  return looksLikePath(r) ? repoName(worktreeRoot(r)) : r;
}

/** What to save for a typed repo: the folder name, and a real path when there
 *  is one. An absolute path is kept as typed (tidied to its repo root): a
 *  known repo with the same folder name may be a different checkout. A "~"
 *  path is not expanded here (the browser has no home dir), so it takes the
 *  path of the known repo with that name, or none. Blank clears. Null means
 *  the path names no folder ("~", "/"), so there is nothing to save. */
export function normaliseRepo(input: string, known: KnownRepo[]): { repo: string; repoPath?: string } | null {
  const raw = input.trim();
  if (!looksLikePath(raw)) return { repo: raw };
  const root = worktreeRoot(raw);
  const repo = repoName(root);
  if (!repo || repo === "~") return null;
  const path = isAbsolute(root) ? root : known.find((k) => k.name === repo)?.path;
  return path ? { repo, repoPath: path } : { repo };
}

/** Every repo the board knows: scrum cards first (they define the projects),
 *  then other cards' labels, then the folders live agents work in. One entry
 *  per name, keeping the first real path seen, sorted by name. */
export function knownRepos(board: Board, agents: Pick<AgentStatus, "cwd">[]): KnownRepo[] {
  const byName = new Map<string, KnownRepo>();
  const add = (name: string, path?: string) => {
    if (!name) return;
    const p = path && isAbsolute(path) ? path : undefined;
    const had = byName.get(name);
    if (!had) byName.set(name, p ? { name, path: p } : { name });
    else if (!had.path && p) had.path = p;
  };
  const scrum = board.cards.filter((c) => c.kind === "scrum");
  for (const c of [...scrum, ...board.cards.filter((c) => c.kind !== "scrum")]) {
    const raw = (c.repo ?? "").trim();
    add(repoKey(raw), c.repoPath?.trim() || (isAbsolute(raw) ? worktreeRoot(raw) : undefined));
  }
  for (const a of agents) {
    const root = worktreeRoot(a.cwd.trim());
    if (root) add(repoName(root), root);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function cardInFilter(card: Card, filter: RepoFilter): boolean {
  if (filter.kind === "all") return true;
  const key = repoKey(card.repo);
  return filter.kind === "none" ? !key : key === filter.repo;
}

export function filterCards<T extends Card>(cards: T[], filter: RepoFilter): T[] {
  return filter.kind === "all" ? cards : cards.filter((c) => cardInFilter(c, filter));
}

/** The repo a card added in this view should carry, or null for none. */
export function filterRepo(filter: RepoFilter, known: KnownRepo[]): { repo: string; repoPath?: string } | null {
  if (filter.kind !== "repo") return null;
  const path = known.find((k) => k.name === filter.repo)?.path;
  return path ? { repo: filter.repo, repoPath: path } : { repo: filter.repo };
}

/** The project + SCRUM MASTER makes a card for: the filtered repo when the
 *  view is on one (so the card lands in view), else the fallback folder (the
 *  last launch, or a live agent's). */
export function scrumTarget(filter: RepoFilter, known: KnownRepo[], fallback: string): { repo: string; folder: string } {
  if (filter.kind === "repo") return { repo: filter.repo, folder: known.find((k) => k.name === filter.repo)?.path ?? "" };
  return { repo: fallback ? repoName(fallback) : "", folder: fallback };
}

/** Watched cards (ones you just made, opened or launched an agent for) that the
 *  filter hid between two boards: visible before, or new, and hidden now. The
 *  same filter judges both boards, so changing the filter yourself never counts. */
export function newlyHidden(before: Card[], after: Card[], watched: Iterable<string>, filter: RepoFilter): Card[] {
  if (filter.kind === "all") return [];
  const ids = new Set(watched);
  const was = new Map(before.map((c) => [c.id, c]));
  return after.filter((c) => {
    if (!ids.has(c.id) || cardInFilter(c, filter)) return false;
    const prev = was.get(c.id);
    return !prev || cardInFilter(prev, filter);
  });
}

export function serialiseRepoFilter(f: RepoFilter): string {
  return f.kind === "repo" ? `repo:${f.repo}` : f.kind;
}

/** Storage can hold anything; whatever doesn't parse shows the whole board. */
export function parseRepoFilter(raw: string): RepoFilter {
  if (raw === "none") return { kind: "none" };
  if (raw.startsWith("repo:")) {
    const repo = raw.slice(5).trim();
    if (repo) return { kind: "repo", repo };
  }
  return { kind: "all" };
}

export function loadRepoFilter(): RepoFilter {
  return parseRepoFilter(loadSetting(KEYS.lineRepo, ""));
}

export function saveRepoFilter(f: RepoFilter): void {
  saveSetting(KEYS.lineRepo, serialiseRepoFilter(f));
}

// ---- moving cards in a filtered view ------------------------------------------
// Drops and keyboard moves are positioned among the cards you can SEE, but the
// board orders every card in the column. These turn a visible position into the
// real one, so a card lands next to the neighbour it was dropped by rather than
// next to a hidden card (or not visibly moving at all).

/** The column index (counted without the moved card, as moveCard takes it) for a
 *  drop at `at` among `visible`. Undefined means append. */
export function dropIndex(column: Card[], visible: Card[], at: number, movedId: string): number | undefined {
  const rest = column.filter((k) => k.id !== movedId);
  const at_ = Math.max(0, Math.min(at, visible.length));
  for (let j = at_; j < visible.length; j++) {
    if (visible[j]!.id !== movedId) return rest.findIndex((k) => k.id === visible[j]!.id);
  }
  for (let j = at_ - 1; j >= 0; j--) {
    if (visible[j]!.id !== movedId) return rest.findIndex((k) => k.id === visible[j]!.id) + 1;
  }
  return undefined;
}

/** cardMoveTarget, but stepping over hidden cards: up/down swaps with the
 *  visible neighbour, left/right keeps the card's visible row. */
export function visibleMoveTarget(
  board: Board, id: string, dir: "left" | "right" | "up" | "down", filter: RepoFilter,
): { toColumnId: string; toIndex?: number } | null {
  const card = board.cards.find((k) => k.id === id);
  if (!card) return null;
  const inCol = (colId: string) => board.cards.filter((k) => k.columnId === colId);
  const visible = filterCards(inCol(card.columnId), filter);
  const row = visible.findIndex((k) => k.id === id);
  if (dir === "up" || dir === "down") {
    const next = dir === "down" ? row + 1 : row - 1;
    if (row === -1 || next < 0 || next >= visible.length) return null;
    // down lands after the next visible card, up before the previous one
    const at = dir === "down" ? next + 1 : next;
    return { toColumnId: card.columnId, toIndex: dropIndex(inCol(card.columnId), visible, at, id) };
  }
  const colAt = board.columns.findIndex((c) => c.id === card.columnId);
  const toCol = colAt === -1 ? undefined : board.columns[colAt + (dir === "right" ? 1 : -1)];
  if (!toCol) return null;
  const target = filterCards(inCol(toCol.id), filter);
  return { toColumnId: toCol.id, toIndex: dropIndex(inCol(toCol.id), target, Math.max(0, row), id) };
}
