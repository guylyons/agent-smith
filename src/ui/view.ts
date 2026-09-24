// The app's two pages. Tiny and DOM-free so it can be unit-tested.
export type AppView = "workshop" | "mood";

/** The page a URL hash asks for; anything unrecognised is the workshop. */
export function viewFromHash(hash: string): AppView {
  return hash.replace(/^#/, "") === "mood" ? "mood" : "workshop";
}
