// Turn free text (a task description or typed name) into a branch/dir-safe slug:
// lowercase, non-alphanumeric runs to single dashes, trimmed, capped to a handful
// of words and 40 chars. Pure and import-free so the browser bundle can use it too.
export function slugify(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean);
  return words.slice(0, 6).join("-").slice(0, 40).replace(/-+$/g, "");
}

// A branch name may be namespaced (`feat/thing`, `fix/AG-1`), which slugify
// would flatten into one dash-joined run. Slugify each `/`-separated segment
// instead and rejoin, so the shape the user typed survives while every segment
// stays branch-safe. Empty segments drop out, so `//a/` can't produce a ref git
// rejects (or a path that climbs out of a directory).
export function slugifyBranch(text: string): string {
  return text.split("/").map(slugify).filter(Boolean).join("/");
}
