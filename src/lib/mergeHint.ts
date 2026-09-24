// The line under a card that is waiting in Review or Done with no MERGE key.
// A branch landed outside the dashboard (merged by hand, or its worktree gone)
// leaves nothing to merge, and without a word the card just sits there. This
// says why, and names the column to move it to (mergedColumn — the one rule
// for where merged work goes).
//
// Pure and browser-safe: it goes into the UI bundle, so type-only imports
// from merge.ts.
import type { MergeState } from "./merge";
import { columnStage, mergedColumn, type Board, type Card } from "./board";

/** What the modal knows about the card's merge state right now. */
export type MergeRead =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "state"; state: MergeState };

export type MergeHint = {
  tone: "loading" | "idle" | "error";
  text: string;
  /** the column the button moves the card to; absent while loading */
  moveTo?: { id: string; name: string };
};

/** One sentence from a reason that may or may not end in a full stop. */
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

/**
 * The hint for this card, or null when there's nothing to say: the card isn't
 * in a review- or done-stage column, it's already in the merged column, the
 * board has nowhere to move it, or there IS work to merge (the key speaks).
 */
export function mergeHint(board: Board, card: Card, read: MergeRead): MergeHint | null {
  const col = board.columns.find((c) => c.id === card.columnId);
  const stage = col && columnStage(col);
  if (stage !== "review" && stage !== "done") return null;
  const to = mergedColumn(board);
  if (!to || to.id === card.columnId) return null;
  const moveTo = { id: to.id, name: to.name || "Untitled" };

  if (read.kind === "loading") return { tone: "loading", text: "Checking the branch…" };
  if (read.kind === "error") return { tone: "error", text: `Can't read this card's branch: ${sentence(read.message)}`, moveTo };

  const s = read.state;
  if (s.committed) return null;
  if (s.worktreeGone && !s.landed) {
    const text = s.branch ? sentence(s.blocked.charAt(0).toUpperCase() + s.blocked.slice(1))
      : `This card's worktree was removed. If its work is merged, move it to ${moveTo.name}.`;
    return { tone: "idle", text, moveTo };
  }
  if (s.landed) return { tone: "idle", text: `${s.branch} is already in ${s.base}, merged outside the dashboard.`, moveTo };
  return { tone: "idle", text: `Nothing to merge: ${sentence(s.blocked || "no committed work on this branch")}`, moveTo };
}
