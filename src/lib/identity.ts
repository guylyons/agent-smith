// One place that decides who a session is: a display name + a role/spec line.
// Used by BOTH the hook writer and the transcript scanner so a session looks the
// same however it was surfaced. A branch that matches a known work type keeps the
// mock's persona (FORGE for component work, etc.); anything else gets a stable
// roster name from the sessionId and shows its repo as the role, so every open
// window reads as a distinct person doing recognizable work. This is the
// fallback: a session with a crew (src/lib/crew.ts) shows its crew name instead.
import { inferRole } from "./role";
import { rosterName } from "./crew";


function repoName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function identify(sessionId: string, branch: string | null, cwd: string): { role: string; name: string } {
  const inferred = inferRole(branch, cwd);
  if (inferred.matched) return { role: inferred.role, name: inferred.name }; // a persona (FORGE/SCOUT/…) matched
  const repo = repoName(cwd);
  return {
    role: repo || "General",
    name: rosterName(sessionId),
  };
}
