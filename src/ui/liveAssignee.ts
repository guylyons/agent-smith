// The live session behind a card's assignee, if any.
//
// Matched by session id OR crew id: the same agent comes back under a new
// session id after a /clear, and its crew id is what outlives the session (see
// src/lib/crew.ts, which has the server's copy of this rule — it isn't imported
// here because crew.ts doesn't belong in the browser bundle). The card face and
// the card modal both ask this one function, so they can never disagree about
// whether an assignee is still running.
import type { AgentStatus } from "../schema";
import type { Assignee } from "../lib/board";

export function findLiveAssignee<A extends Pick<AgentStatus, "sessionId" | "crew">>(
  agents: A[], assignee: Assignee | null | undefined,
): A | undefined {
  if (!assignee) return undefined;
  return agents.find((a) => a.sessionId === assignee.id || (!!assignee.crew && a.crew?.id === assignee.crew));
}
