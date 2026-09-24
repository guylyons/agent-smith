// The pure pieces of the Merged column's ARCHIVE bar (ArchiveBar.tsx): what
// the confirm asks, what the toast says, and where focus goes when a button
// or row it was on goes away. DOM-free so they're tested directly.
import type { RepoFilter } from "./repoFilter";

const plural = (n: number) => `${n} card${n === 1 ? "" : "s"}`;

/** The confirm question, naming the count and which cards: "Archive 12
 *  agent-smith cards?" under a repo filter, "Archive all 87 cards?" without. */
export function archivePrompt(n: number, filter: RepoFilter): string {
  if (filter.kind === "repo") return `Archive ${n} ${filter.repo} card${n === 1 ? "" : "s"}?`;
  if (filter.kind === "none") return `Archive ${plural(n)} with no repo?`;
  return n === 1 ? "Archive 1 card?" : `Archive all ${n} cards?`;
}

/** The toast after an archive; its UNDO restores the batch. */
export function archivedToast(n: number): string {
  return n ? `Archived ${plural(n)}` : "Nothing to archive";
}

/** After `goneId` leaves a list of `ids`, the one to focus: the next row, else
 *  the previous one, else null (the list is now empty). */
export function neighbourAfter(ids: string[], goneId: string): string | null {
  const i = ids.indexOf(goneId);
  if (i < 0) return ids[0] ?? null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** The line under an open ARCHIVED list when a repo filter hides some of it:
 *  "3 of 87 match the repo filter", or null when nothing is hidden. */
export function archiveFilterNote(shown: number, total: number): string | null {
  return shown === total ? null : `${shown} of ${total} match the repo filter`;
}

/** Where focus goes after a restore: the neighbouring row, else the bar's
 *  ARCHIVE button (the card is back in the column), else the ARCHIVED toggle.
 *  Targets are tried in order, as each may not be mounted yet. */
export function focusAfterRestore(rowIds: string[], restoredId: string): string[] {
  const next = neighbourAfter(rowIds, restoredId);
  return [...(next ? [`row:${next}`] : []), "archive", "toggle"];
}
