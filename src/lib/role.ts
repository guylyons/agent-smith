interface RoleDef { match: string[]; role: string; name: string; }

const TABLE: RoleDef[] = [
  { match: ["component", "card", "twig", "scss", "theme"], role: "Component build", name: "FORGE" },
  { match: ["doc", "changelog", "readme"], role: "Docs & changelog", name: "SCRIBE" },
  { match: ["test", "profile", "perf", "xhprof"], role: "Test & profile", name: "PROBE" },
  { match: ["migrat", "d10", "d11", "upgrade"], role: "Migration", name: "SHIFT" },
  { match: ["triage", "issue", "scope"], role: "Ticket triage", name: "SCOUT" },
];

export function inferRole(branch: string | null, cwd: string): { role: string; name: string } {
  const hay = `${branch ?? ""} ${cwd}`.toLowerCase();
  for (const d of TABLE) if (d.match.some((k) => hay.includes(k))) return { role: d.role, name: d.name };
  return { role: "General", name: "AGENT" };
}
