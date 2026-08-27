interface RoleDef { match: string[]; role: string; name: string; }

const TABLE: RoleDef[] = [
  { match: ["component", "card", "twig", "scss", "theme"], role: "Component build", name: "FORGE" },
  { match: ["doc", "changelog", "readme"], role: "Docs & changelog", name: "SCRIBE" },
  { match: ["test", "profile", "perf", "xhprof"], role: "Test & profile", name: "PROBE" },
  { match: ["migrat", "d10", "d11", "upgrade"], role: "Migration", name: "SHIFT" },
  { match: ["triage", "issue", "scope"], role: "Ticket triage", name: "SCOUT" },
];

export function inferRole(branch: string | null, cwd: string): { role: string; name: string; matched: boolean } {
  // Match against the branch and the repo's own directory name only (not the
  // whole absolute path), tokenized on non-alphanumerics, requiring a key to be
  // the PREFIX of a token. This keeps deliberate stems ("migrat"→migration,
  // "doc"→docs) working while no longer misreading ancestor folders — e.g.
  // ~/Documents/foo no longer reads as "doc", and latest-app no longer as "test".
  const base = cwd.split("/").filter(Boolean).pop() ?? "";
  const tokens = `${branch ?? ""} ${base}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const has = (k: string) => tokens.some((t) => t.startsWith(k));
  for (const d of TABLE) if (d.match.some(has)) return { role: d.role, name: d.name, matched: true };
  return { role: "General", name: "AGENT", matched: false };
}
