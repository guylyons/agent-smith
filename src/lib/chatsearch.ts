// Chat-transcript search — the pure half. Given a parsed conversation and a
// query, find the most recent human/assistant message that mentions it and
// return a compact snippet. Substring (not fuzzy): chat text is long and free-
// form, so a fuzzy subsequence would match almost anything; a literal mention is
// what a user means by "find that chat about X". The filesystem half (which
// transcripts to read) lives in the server.
import type { ChatMessage } from "./conversation";

export type ChatHit = { role: ChatMessage["role"]; snippet: string };

const SNIPPET_PAD = 60; // chars of context on each side of the match

/** A window of `text` centred on the match at `idx`, with ellipses when clipped. */
function snippetAround(text: string, idx: number, matchLen: number): string {
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(text.length, idx + matchLen + SNIPPET_PAD);
  const core = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`;
}

/**
 * The most recent real conversation message (user or assistant — tool-activity
 * lines are skipped as noise) that contains `query`, case-insensitively, as a
 * snippet. Null when the query is blank or nothing matches.
 */
export function matchChat(messages: ChatMessage[], query: string): ChatHit | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") continue;
    const idx = m.text.toLowerCase().indexOf(q);
    if (idx >= 0) return { role: m.role, snippet: snippetAround(m.text, idx, q.length) };
  }
  return null;
}
