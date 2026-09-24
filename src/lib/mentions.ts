// @mentions in card comments: "@DALLAS is the /card shape stable?" reaches
// DALLAS as well as the card's usual audience. Pure: the server matches the
// tokens against the live desk and delivers; the UI draws them as chips.

import type { AgentStatus } from "../schema";

// An @ that starts a word (so a@b.com is not one), then a name or crew id:
// letters, digits, "_" and inner "-". A token running on into ".com" or
// another @ is an address, not a mention.
const MENTION_RE = /(?<![A-Za-z0-9_.+%@-])@([A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)(?![A-Za-z0-9_@]|\.[A-Za-z0-9])/g;

export type MentionPart = { text: string; mention?: string };

/** Text as plain and mention pieces, in order; joined back it is the input. */
export function splitMentions(text: string): MentionPart[] {
  const out: MentionPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], mention: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length || !out.length) out.push({ text: text.slice(last) });
  return out;
}

/** The names a comment mentions, without the @, first spelling of each kept.
 *  Code (fenced or inline) is not read: `npm i @types/bun` mentions nobody. */
export function parseMentions(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of splitMentions(prose)) {
    if (!p.mention || seen.has(p.mention.toLowerCase())) continue;
    seen.add(p.mention.toLowerCase());
    out.push(p.mention);
  }
  return out;
}

type Mentionable = Pick<AgentStatus, "sessionId" | "name" | "crew">;

/** Does this mention name this agent? By desk name (with or without the
 *  session fragment the snapshot adds when two desks share a name), crew name
 *  or crew id, ignoring case. */
export function mentionsAgent(mention: string, a: Mentionable): boolean {
  const m = mention.toLowerCase();
  const names = [a.name, a.crew?.name, a.crew?.id];
  const frag = ` ${a.sessionId.slice(0, 4)}`;
  if (a.name.endsWith(frag)) names.push(a.name.slice(0, -frag.length));
  return names.some((n) => n?.toLowerCase() === m);
}

/** Pair each mention with the live agents it names; each agent once, under
 *  the first mention that named it. A mention naming nobody is `unmatched`. */
export function matchMentions<A extends Mentionable>(mentions: string[], agents: A[]): { hits: { mention: string; agent: A }[]; unmatched: string[] } {
  const hits: { mention: string; agent: A }[] = [];
  const unmatched: string[] = [];
  for (const mention of mentions) {
    const named = agents.filter((a) => mentionsAgent(mention, a));
    if (!named.length) unmatched.push(mention);
    for (const agent of named) if (!hits.some((h) => h.agent === agent)) hits.push({ mention, agent });
  }
  return { hits, unmatched };
}
