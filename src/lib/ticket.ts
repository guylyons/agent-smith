// Heuristic ticket-number extraction from a branch name.
//
// Tried in priority order:
//   1. An explicit "#123" reference.
//   2. A project-prefixed ticket like "PROJ-123" / "MHO-123" — two-or-more
//      letters, a dash, then digits, sitting on its own segment.
//   3. A bare digit-run that is clearly its own segment: bounded on both
//      sides by "/", "_", "-", or the start/end of the string, 1-6 digits.
//
// To avoid false positives on dates and version-ish segments:
//   - Before anything else, calendar-looking dates (a 1900-2099 year
//     immediately followed by "-MM" and optionally "-DD", e.g. the
//     "2024-01" in "chore/2024-01-migration") are masked out so neither the
//     year nor the month/day digits can be mistaken for a ticket number.
//   - A digit-run glued directly onto a preceding letter with no separator
//     (e.g. the "10"/"11" in "d10"/"d11", the "2" in "v2") is never treated
//     as its own segment — the bounded-digit-run pattern requires a real
//     separator (or start-of-string) immediately before the digits, and the
//     prefixed pattern requires 2+ letters before the dash, so a single
//     glued letter like "d" or "v" doesn't qualify either.
export function parseTicket(branch: string | null): string | null {
  if (!branch) return null;

  // Mask out YYYY-MM(-DD) date segments so their digits never get picked up
  // as a ticket number below.
  const cleaned = branch.replace(/(19|20)\d{2}-\d{2}(-\d{2})?/g, (s) => "~".repeat(s.length));

  const hash = cleaned.match(/#(\d{1,6})/);
  if (hash) return `#${hash[1]}`;

  const prefixed = cleaned.match(/(?:^|[/_-])[A-Za-z]{2,}-(\d{1,6})(?=[/_-]|$)/);
  if (prefixed) return `#${prefixed[1]}`;

  const bare = cleaned.match(/(?:^|[/_-])(\d{1,6})(?=[/_-]|$)/);
  if (bare) return `#${bare[1]}`;

  return null;
}

/** A card's id as people see it: its number ("#42", see Card.num), or, for a
 *  card not numbered yet, its stored id without the "card_" prefix. */
export function cardRef(card: { id: string; num?: number }): string {
  return card.num ? `#${card.num}` : card.id.replace(/^card_/, "");
}
