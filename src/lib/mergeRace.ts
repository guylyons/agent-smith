// The gap between the MERGE key lighting up and a human pressing it. The key's
// state comes from readMergeState (src/lib/merge.ts), read on a poll with no
// queue slot held, so by the confirming press it can be stale: another card's
// merge landed, the tree went dirty, the work was landed some other way.
// mergeWork re-verifies inside the queue, so a stale press never merges
// anything it shouldn't — these rules are about what the person is TOLD.
//
// Pure and browser-safe: it goes into the UI bundle, so type-only imports.
import type { MergeState } from "./merge";

/** The words for "this key's state moved since it lit up". */
function changedSince(fresh: MergeState): string {
  if (!fresh.committed) return `Nothing to merge any more — ${fresh.blocked}.`;
  if (fresh.merging) return `Not merged — another merge is landing on ${fresh.base} first. Try again in a moment.`;
  return `Not merged — this changed since the key lit up: ${fresh.blocked}. Try again once that's cleared.`;
}

/** The confirming press, given the state re-read just now: send the merge, or
 *  hold it and say why. A failed re-read holds too — nothing was sent. */
export function mergeGate(fresh: MergeState | null): { go: true } | { go: false; message: string } {
  if (!fresh) return { go: false, message: "Couldn't re-check the branch, so nothing was merged. Try again." };
  if (fresh.ready) return { go: true };
  return { go: false, message: changedSince(fresh) };
}

/** The toast for a merge the server refused, given the state re-read after it.
 *  If that state no longer reads ready, the refusal was the state moving in
 *  the moment between our check and the queue — say so. If it still reads
 *  ready, the refusal was something the key can't see (a conflict), and the
 *  server's own words are the useful ones. */
export function mergeRefusal(error: string, fresh: MergeState | null): string {
  if (fresh && !fresh.ready) return changedSince(fresh);
  return error;
}
