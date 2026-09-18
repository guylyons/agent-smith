// Persona definitions: who an agent is when you launch it. Each `personas/*.md`
// file carries YAML frontmatter (identity + look + the skills it should reach
// for) and a prompt body appended to the session's system prompt at launch.
// A malformed file is skipped, never fatal — one bad persona must not empty the
// picker or crash a snapshot.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentStatus } from "../schema";
import { BODIES, PALETTES } from "../ui/sprite-data";

// Also duplicated in hooks/status.ts: the hook keeps its own copy deliberately
// so it never has to load this registry.
export const PERSONA_ID_RE = /^[a-z0-9-]{1,64}$/;

const PersonaMetaSchema = z.object({
  id: z.string().regex(PERSONA_ID_RE),
  // Optional, and the shipped personas leave it out: a persona is a ROLE, and
  // the name belongs to the crew member the dashboard spawns into it (see
  // src/lib/crew.ts), so two frontend-ux agents are RIPLEY and VASQUEZ rather
  // than PIXEL twice. A persona that still names itself is a fixed codename.
  name: z.string().min(1).optional(),
  role: z.string().min(1),
  // Optional, like `name`: without it the desk wears the look its crew name
  // earns (the Alien cast in src/ui/sprite-alien.ts), so a persona only sets a
  // sprite when the role should look the same whoever plays it.
  sprite: z.object({
    body: z.string().min(1),
    palette: z.number().int().min(0).max(PALETTES.length - 1),
    // Gear overlays are only positioned for the `worker` body; every other body
    // ignores it, so an omitted gear is the empty string rather than an error.
    gear: z.string().default(""),
  }).optional(),
  skills: z.array(z.string().min(1)).default([]),
});

export type Persona = z.infer<typeof PersonaMetaSchema> & { prompt: string };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** The directory the built-in personas ship in (repo root / personas). */
export const PERSONAS_DIR = join(import.meta.dir, "..", "..", "personas");

/** Parse one persona file. `stem` is the filename without `.md`; a file whose
 *  `id` disagrees with its own name is rejected rather than silently renamed. */
export function parsePersona(text: string, stem: string): Persona | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  let meta: unknown;
  try { meta = Bun.YAML.parse(m[1]); } catch { return null; }
  const r = PersonaMetaSchema.safeParse(meta);
  if (!r.success) return null;
  if (r.data.id !== stem) return null;
  if (r.data.sprite && !(r.data.sprite.body in BODIES)) return null;
  const prompt = m[2].trim();
  if (!prompt) return null;
  return { ...r.data, prompt };
}

// loadPersonas runs on every snapshot (each fs-watch push, /board, /agents, ...),
// so it caches rather than re-parsing YAML each time. The listing is keyed by the
// directory's mtime + inode (a file added, removed or renamed moves it); each
// parse by that file's mtime + size, because an editor that writes in place
// leaves the directory's mtime alone. A stat is the cheapest way to see a change.
type DirCache = { key: string; names: string[] };
const listingCache = new Map<string, DirCache>();
const parseCache = new Map<string, { key: string; persona: Persona | null }>();

/** Every valid persona in `dir`, sorted by id. Cheap to call repeatedly: only
 *  a persona file that changed since the last call is re-read, so editing one
 *  still takes effect without restarting the server. */
export function loadPersonas(dir: string = PERSONAS_DIR): Persona[] {
  let names: string[];
  try {
    const st = statSync(dir);
    const key = `${st.ino}:${st.mtimeMs}`;
    const hit = listingCache.get(dir);
    if (hit && hit.key === key) names = hit.names;
    else {
      names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
      listingCache.set(dir, { key, names });
    }
  } catch { listingCache.delete(dir); return []; }
  const out: Persona[] = [];
  for (const f of names) {
    const file = join(dir, f);
    try {
      const st = statSync(file);
      const key = `${st.mtimeMs}:${st.size}`;
      let hit = parseCache.get(file);
      if (!hit || hit.key !== key) {
        hit = { key, persona: parsePersona(readFileSync(file, "utf8"), f.slice(0, -3)) };
        parseCache.set(file, hit);
      }
      if (hit.persona) out.push(hit.persona);
    } catch { parseCache.delete(file); /* gone or unreadable; skip */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getPersona(id: string, dir: string = PERSONAS_DIR): Persona | null {
  if (!PERSONA_ID_RE.test(id)) return null;
  return loadPersonas(dir).find((p) => p.id === id) ?? null;
}

/** The shared board protocol every launched agent plays by, addressed to the
 *  name the board shows it under. Pure ASCII: this text rides into the session
 *  as an argv through a path known to mangle anything else. */
function boardProtocol(name: string): string {
  return [
    "",
    "",
    `Board protocol: the team board knows you as ${name}. If a task carries a`,
    '"-- THE LINE --" footer, follow its protocol exactly: move your card and',
    "comment through the curl commands it gives, as you work, signed exactly as",
    'they show. A message starting with "[THE LINE]" is a board notification and',
    "says whether an answer is wanted: reply expected means answer on that card",
    "with a card-comment; no reply needed means read it and carry on, and comment",
    "only if it changes your work. Write board comments plainly and simply: short, direct",
    "sentences a busy teammate can skim, plain words over jargon, no filler or",
    "self-promotion -- unless the card asks for more detail. The dashboard's",
    "base URL is in $AGENT_WORKSHOP_URL (default",
    "http://localhost:4173) -- but in shell commands always write the URL out",
    "literally, exactly as your task footer shows it: permission allowlists match",
    "the literal command text, so an env-var form stalls on an approval prompt.",
  ].join("\n");
}

/** The text appended to the session's system prompt: an identity line (so the
 *  agent knows the name its desk and board comments go by), the persona's own
 *  body, a generated line naming its skills (so `skills:` stays declarative
 *  data rather than prose each author has to remember to write twice), and the
 *  shared board protocol every persona plays by. `name` is the crew member's
 *  name minted at spawn; a persona with its own fixed name is the fallback.
 *  Claude Code skills are model-invoked — naming them is the strongest lever a
 *  persona has; it cannot force them to load. */
export function composePrompt(p: Persona, name?: string): string {
  const who = name ?? p.name;
  const skills = p.skills.length === 0
    ? ""
    : `\n\nReach for ${p.skills.map((s) => `\`${s}\``).join(", ")} via the Skill tool when the work calls for it.`;
  const opening = who ? `You are ${who}, the team's ${p.role}.` : `You are the team's ${p.role}.`;
  return `${opening}\n\n${p.prompt}${skills}${boardProtocol(who ?? "your desk name")}`;
}

/** The system prompt for a spawn with a crew name but no persona: just who the
 *  agent is and how the board works, so a plain worker still signs and
 *  follows the protocol under the name its desk shows. */
export function composeIdentityPrompt(name: string): string {
  return `You are ${name}, a member of this team.${boardProtocol(name)}`;
}

/** Fill name/role/sprite from each agent's persona. Mirrors `applyOverrides` in
 *  overrides.ts: pure, never mutates its inputs. Call it INSIDE applyOverrides —
 *  overrides are applied last so a name you typed yourself always wins. */
export function applyPersonas(agents: AgentStatus[], personas: Persona[]): AgentStatus[] {
  if (personas.length === 0) return agents;
  const byId = new Map(personas.map((p) => [p.id, p]));
  return agents.map((a) => {
    const p = a.persona ? byId.get(a.persona) : undefined;
    return p ? { ...a, ...(p.name ? { name: p.name } : {}), role: p.role, ...(p.sprite ? { sprite: { ...p.sprite } } : {}) } : a;
  });
}
