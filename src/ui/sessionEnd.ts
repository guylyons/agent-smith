// Moving a card into Done (or past it) quits its agent's terminal: the server's
// endFinishedSession, with no undo — moving the card back does not bring the
// session back. So every UI path that moves a card (drag, Alt+arrows, the card
// modal's STAGE select) asks here first, and a move that would end a live
// session waits for the human to say yes in the EndConfirm dialog.
//
// Pure rule plus a tiny bus, like toast.ts: anything can ask, the one dialog
// mounted in App answers.
import { finishesCard, type Board } from "../lib/board";
import { findLiveAssignee } from "../lib/sendTaskReady";
import type { AgentStatus } from "../schema";

/** Would moving this card to `toColumnId` end a running session? Returns the
 *  agent's name when it would, null when the move is harmless. The same test
 *  the server makes (finishesCard), narrowed to an assignee that is live now:
 *  an ended session has nothing left to lose. */
export function endsLiveSession(
  board: Board, agents: Pick<AgentStatus, "sessionId" | "crew" | "name">[], cardId: string, toColumnId: string,
): string | null {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card?.assignee || !finishesCard(board, card.columnId, toColumnId)) return null;
  const live = findLiveAssignee(agents, card.assignee);
  return live ? live.name || card.assignee.name : null;
}

export type EndRequest = { id: number; cardId: string; agent: string; column: string; answer: (ok: boolean) => void };

let seq = 0;
const listeners = new Set<(r: EndRequest) => void>();

export function subscribeEndConfirm(cb: (r: EndRequest) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Run `go` now when the move ends no live session; otherwise ask first and run
 *  it only on a yes. With no dialog mounted to ask, it does not move. */
export function guardSessionEnd(
  board: Board, agents: Pick<AgentStatus, "sessionId" | "crew" | "name">[],
  cardId: string, toColumnId: string, go: () => void,
): void {
  const agent = endsLiveSession(board, agents, cardId, toColumnId);
  if (!agent) { go(); return; }
  const column = board.columns.find((c) => c.id === toColumnId)?.name || "Done";
  const r: EndRequest = { id: ++seq, cardId, agent, column, answer: (ok) => { if (ok) go(); } };
  for (const l of listeners) l(r);
}
