import type { UiState } from "../lib/snapshot";

// After a MERGE of a UI change the server rebuilds dist/ and the snapshot's
// `ui.version` moves (see rebuildUiAfterMerge in server.ts). This page is still
// running the build it loaded, so it offers a reload. A failed rebuild is
// toasted once; one that happened before this page opened is old news.

/** What this page has seen: the build it loaded, and the last failure it knows. */
export type UiSeen = { loaded?: string; failedAt?: number };

/** Fold one snapshot's `ui` into what this page has seen. Pure. */
export function watchUi(seen: UiSeen, ui: UiState | undefined): { seen: UiSeen; reload: boolean; failed?: string } {
  if (!ui) return { seen, reload: false };
  if (seen.loaded === undefined) return { seen: { loaded: ui.version, failedAt: ui.failed?.at }, reload: false };
  const reload = !!ui.version && ui.version !== seen.loaded;
  const fresh = ui.failed && ui.failed.at !== seen.failedAt ? ui.failed : undefined;
  return {
    seen: { ...seen, failedAt: ui.failed?.at ?? seen.failedAt },
    reload,
    ...(fresh ? { failed: fresh.error } : {}),
  };
}
