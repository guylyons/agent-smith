// The app's pages. Tiny and DOM-free so it can be unit-tested.
export type AppView = "workshop" | "mood" | "game";

/** The page a URL hash asks for; anything unrecognised is the workshop. */
export function viewFromHash(hash: string): AppView {
  const h = hash.replace(/^#/, "");
  return h === "mood" || h === "game" ? h : "workshop";
}

/** The hash that shows a page: the workshop is the bare URL. */
export function hashForView(v: AppView): string {
  return v === "workshop" ? "" : v;
}
