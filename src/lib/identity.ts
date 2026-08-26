// One place that decides who a session is: a display name + a role/spec line.
// Used by BOTH the hook writer and the transcript scanner so a session looks the
// same however it was surfaced. A branch that matches a known work type keeps the
// mock's persona (FORGE for component work, etc.); anything else gets a stable
// codename from the sessionId and shows its repo as the role, so every open window
// reads as a distinct person doing recognizable work.
import { inferRole } from "./role";

const CODENAMES = [
  "NOVA", "RELAY", "ANVIL", "EMBER", "QUILL", "VOLT", "MASON", "PIXEL",
  "ROOK", "SABLE", "TALLY", "FLINT", "WREN", "ONYX", "CLOVE", "DELTA",
  "ORBIT", "GLYPH", "AXLE", "CEDAR", "VERGE", "MICA", "SLATE", "HAZEL",
  "JUNO", "LOOM", "MOSS", "OTTER", "PACER", "QUARK", "RIVET", "TIDE",
  "UMBER", "VESPER", "WILLOW", "XENO", "YARROW", "ZEPHYR", "BRIO", "COBALT",
  "DRIFT", "FABLE", "GROVE", "HALO", "INDIGO", "KESTREL", "LUMEN", "MARLOW",
].map((n) => n.toUpperCase());

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

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
    name: CODENAMES[hash(sessionId) % CODENAMES.length],
  };
}
