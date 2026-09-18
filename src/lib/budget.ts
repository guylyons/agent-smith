// The one place the harness's token-budget marker is parsed.
//
// Every turn's context carries "<total_tokens>N tokens left</total_tokens>".
// Both readers of it -- the transcript's newest marker (budgetLeft) and a
// session head's first marker (budgetTotal) -- come through here, so the day
// the harness changes the marker's shape it is one regex to change, not two
// that can drift apart and silently stop reporting usage.
//
// Matched on raw text (the marker needs no JSON escaping), so it is found
// regardless of which transcript entry carries it.

const TOKENS_LEFT_RE = /<total_tokens>(\d+) tokens left<\/total_tokens>/;
const TOKENS_LEFT_RE_ALL = new RegExp(TOKENS_LEFT_RE.source, "g");

// Cheap reject for the common case: a transcript line with no marker at all.
const MARKER_END = "</total_tokens>";

/** The FIRST budget marker in this text, or null when it carries none. */
export function firstTokensLeftIn(text: string): number | null {
  if (!text.includes(MARKER_END)) return null;
  const m = text.match(TOKENS_LEFT_RE);
  return m ? Number(m[1]) : null;
}

/** The LAST budget marker in this text, or null when it carries none. */
export function lastTokensLeftIn(text: string): number | null {
  if (!text.includes(MARKER_END)) return null;
  let left: number | null = null;
  for (const m of text.matchAll(TOKENS_LEFT_RE_ALL)) left = Number(m[1]);
  return left;
}
