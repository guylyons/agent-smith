// Persona definitions: who an agent is when you launch it. Each `personas/*.md`
// file carries YAML frontmatter (identity + look + the skills it should reach
// for) and a prompt body appended to the session's system prompt at launch.
// A malformed file is skipped, never fatal — one bad persona must not empty the
// picker or crash a snapshot.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BODIES, PALETTES } from "../ui/sprite-data";

export const PERSONA_ID_RE = /^[a-z0-9-]{1,64}$/;

const PersonaMetaSchema = z.object({
  id: z.string().regex(PERSONA_ID_RE),
  name: z.string().min(1),
  role: z.string().min(1),
  sprite: z.object({
    body: z.string().min(1),
    palette: z.number().int().min(0).max(PALETTES.length - 1),
    // Gear overlays are only positioned for the `worker` body; every other body
    // ignores it, so an omitted gear is the empty string rather than an error.
    gear: z.string().default(""),
  }),
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
  if (!(r.data.sprite.body in BODIES)) return null;
  const prompt = m[2].trim();
  if (!prompt) return null;
  return { ...r.data, prompt };
}

/** Every valid persona in `dir`, sorted by id. Re-read on each call so editing a
 *  persona file takes effect without restarting the server. */
export function loadPersonas(dir: string = PERSONAS_DIR): Persona[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; }
  const out: Persona[] = [];
  for (const f of names) {
    try {
      const p = parsePersona(readFileSync(join(dir, f), "utf8"), f.slice(0, -3));
      if (p) out.push(p);
    } catch { /* unreadable file; skip */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getPersona(id: string, dir: string = PERSONAS_DIR): Persona | null {
  if (!PERSONA_ID_RE.test(id)) return null;
  return loadPersonas(dir).find((p) => p.id === id) ?? null;
}

/** The text appended to the session's system prompt: the persona's own body plus
 *  a generated line naming its skills, so `skills:` stays declarative data rather
 *  than prose each author has to remember to write twice.
 *  Claude Code skills are model-invoked — naming them is the strongest lever a
 *  persona has; it cannot force them to load. */
export function composePrompt(p: Persona): string {
  if (p.skills.length === 0) return p.prompt;
  const list = p.skills.map((s) => `\`${s}\``).join(", ");
  return `${p.prompt}\n\nReach for ${list} via the Skill tool when the work calls for it.`;
}
