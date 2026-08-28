// Tiny navigation bus (same shape as toast.ts). Lets the notification center
// ask the board to open a card, or the app to open an agent's drawer, without
// threading callbacks through the whole tree. Subscribers live in TheLine (card)
// and App (agent).

const cardSubs = new Set<(cardId: string) => void>();
const agentSubs = new Set<(sessionId: string) => void>();

export function openCard(cardId: string): void {
  for (const cb of cardSubs) cb(cardId);
}
export function onOpenCard(cb: (cardId: string) => void): () => void {
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
