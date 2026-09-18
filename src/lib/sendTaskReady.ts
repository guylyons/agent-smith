// Is this card ready for SEND TASK? The one rule behind both the SEND TASK
// button (src/ui/CardModal.tsx, sendTaskGate) and the server's send-task
// handler (src/server.ts), so the button can never offer what the server will
// refuse. Each side words the answer its own way: a tooltip there, an HTTP
// error here.
//
// Pure and browser-safe: it goes into the UI bundle, so type-only imports and
// nothing from fs, crew.ts or zod.
import type { AgentStatus } from "../schema";
import type { Assignee } from "./board";

/** The live session behind a card's assignee, if any.
 *
 *  Matched by session id OR crew id: the same agent comes back under a new
 *  session id after a /clear, and its crew id is what outlives the session (see
 *  src/lib/crew.ts, which has the server's copy of this rule for its other
 *  routes). The card face, the card modal and send-task all ask this one
 *  function, so they can never disagree about whether an assignee is running. */
export function findLiveAssignee<A extends Pick<AgentStatus, "sessionId" | "crew">>(
  agents: A[], assignee: Assignee | null | undefined,
): A | undefined {
  if (!assignee) return undefined;
  return agents.find((a) => a.sessionId === assignee.id || (!!assignee.crew && a.crew?.id === assignee.crew));
}

export type SendTaskReadiness<A> =
  | { ready: true; agent: A }
  | { ready: false; why: "unassigned" }
  | { ready: false; why: "ended"; assignee: Assignee }
  | { ready: false; why: "working" | "waiting"; agent: A };

/** A fresh task clears the agent's context first, so it must go to a live
 *  assignee that is idle: sending into a working session would wipe its work
 *  mid-task, and into a waiting one would press keys on its dialog. */
export function sendTaskReadiness<A extends Pick<AgentStatus, "sessionId" | "crew" | "state">>(
  assignee: Assignee | null | undefined, agents: A[],
): SendTaskReadiness<A> {
  if (!assignee) return { ready: false, why: "unassigned" };
  const agent = findLiveAssignee(agents, assignee);
  if (!agent) return { ready: false, why: "ended", assignee };
  if (agent.state === "working" || agent.state === "waiting") return { ready: false, why: agent.state, agent };
  return { ready: true, agent };
}
