// @ autocomplete for the card comment box: which @word the caret is in, which
// live agents it could name, and the text after picking one. Pure, so the
// keyboard handling in CardModal stays thin.

import type { AgentStatus } from "../schema";

export type MentionQuery = { start: number; query: string };
export type MentionOption = { key: string; insert: string; label: string; hint?: string };

const TOKEN_CHAR = /[A-Za-z0-9_-]/;
// What may sit right before the @ (see lib/mentions): not a word or address.
const NOT_BEFORE = /[A-Za-z0-9_.+%@-]/;
const TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/;

/** The @word the caret sits in (start = the @), or null when it isn't in one. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  let i = caret;
  while (i > 0 && TOKEN_CHAR.test(text[i - 1]!)) i--;
  if (text[i - 1] !== "@") return null;
  const start = i - 1;
  if (start > 0 && NOT_BEFORE.test(text[start - 1]!)) return null;
  return { start, query: text.slice(i, caret) };
}

type Mentionable = Pick<AgentStatus, "sessionId" | "name" | "crew">;

/** The live agents a query could name, by prefix of name or crew id. Each
 *  completes to its name, or to its crew id when the name is shared or isn't
 *  a single word, so the server can match the mention to exactly one desk. */
export function mentionOptions(query: string, agents: Mentionable[], limit = 8): MentionOption[] {
  const q = query.toLowerCase();
  const baseOf = (a: Mentionable) => a.crew?.name ?? a.name;
  const shared = (a: Mentionable) => agents.filter((b) => baseOf(b).toLowerCase() === baseOf(a).toLowerCase()).length > 1;
  const out: MentionOption[] = [];
  for (const a of agents) {
    const base = baseOf(a);
    const insert = !shared(a) && TOKEN.test(base) ? base : a.crew?.id;
    if (!insert || out.some((o) => o.insert === insert)) continue;
    if (![insert, base, a.name, a.crew?.id].some((n) => n?.toLowerCase().startsWith(q))) continue;
    out.push({ key: a.sessionId, insert, label: a.name, ...(a.crew && a.crew.id !== insert ? { hint: a.crew.id } : {}) });
  }
  return out.sort((x, y) => x.insert.localeCompare(y.insert)).slice(0, limit);
}

/** The text with the @word under the caret replaced by `@insert`, and where
 *  the caret goes: after the name, and after the space added when no space
 *  already follows it. */
export function applyMention(text: string, q: MentionQuery, caret: number, insert: string): { text: string; caret: number } {
  let end = caret;
  while (end < text.length && TOKEN_CHAR.test(text[end]!)) end++;
  const rest = text.slice(end);
  const pad = /^\s/.test(rest) ? "" : " ";
  const head = `${text.slice(0, q.start)}@${insert}${pad}`;
  return { text: head + rest, caret: head.length };
}
