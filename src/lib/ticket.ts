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

/** The badge for a board card, so a desk working a card shows THAT card's
 *  ticket rather than whatever its branch happens to be named. The title's own
 *  ticket when it has one ("AG-11: Right hand sidebar" → "AG-11"), else a short
 *  form of the card id ("card_1119e443" → "1119e4"). No "#" on the id form, so
 *  it never reads like a branch-parsed ticket number. */
export function cardTicket(card: { id: string; title: string }): string {
  const own = card.title.match(/(?:^|[^A-Za-z0-9])([A-Za-z]{2,}-\d{1,6})(?![A-Za-z0-9])/);
  if (own) return own[1]!.toUpperCase();
  return card.id.replace(/^card_/, "").slice(0, 6);
}
