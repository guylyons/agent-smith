// Tiny navigation bus (same shape as toast.ts). Lets the notification center
// ask the board to open a card, or the app to open an agent's drawer, without
// threading callbacks through the whole tree. Subscribers live in TheLine (card)
// and App (agent).

/** What to land on inside an opened card: one comment (a comment notice), the
 *  stage row (a move notice), or the description editor (a card you just made,
 *  so you can go straight on filling it in). */
export type CardFocus =
  | { kind: "comment"; id: string }
  | { kind: "stage" }
  | { kind: "new" };

const cardSubs = new Set<(cardId: string, focus?: CardFocus) => void>();
const agentSubs = new Set<(sessionId: string) => void>();

export function openCard(cardId: string, focus?: CardFocus): void {
  for (const cb of cardSubs) cb(cardId, focus);
}
export function onOpenCard(cb: (cardId: string, focus?: CardFocus) => void): () => void {
  cardSubs.add(cb);
  return () => cardSubs.delete(cb);
}

export function openAgent(sessionId: string): void {
  for (const cb of agentSubs) cb(sessionId);
}
export function onOpenAgent(cb: (sessionId: string) => void): () => void {
  agentSubs.add(cb);
  return () => agentSubs.delete(cb);
}
