import type { AgentStatus } from "../schema";

// Which cue to play. Kept separate from the WebAudio synth (sounds.ts) so this
// transition logic stays pure and unit-testable.
export type SoundCue = "completion" | "question" | "permission";

// Per-agent state carried between snapshots, keyed by session id.
export type PrevState = Map<string, AgentStatus["state"]>;

export type SoundDiff = { cues: SoundCue[]; next: PrevState };

/**
 * Diff the previous per-agent states against the current agents and decide which
 * sound cues to fire. Pure — no audio, no DOM.
 *
 * Transitions that fire (only once `primed`, and only on an actual state change):
 *   - into `waiting` + reason "question" → "question"
 *   - into `waiting` + permission/undefined → "permission"
 *   - `working` → `idle` → "completion"
 *
 * `primed` guards the first populated snapshot: on the baseline we record states
 * without firing, so agents already in a state on load don't alert. Completion
 * additionally requires a prior `working` state, so a first-sighting idle agent
 * never sounds a completion.
 */
export function soundTransitions(prev: PrevState, agents: AgentStatus[], primed: boolean): SoundDiff {
  const next: PrevState = new Map();
  const cues: SoundCue[] = [];

  for (const a of agents) {
    const before = prev.get(a.sessionId);
    next.set(a.sessionId, a.state);
    if (!primed || a.state === before) continue;

    if (a.state === "waiting") {
      cues.push(a.waitingReason === "question" ? "question" : "permission");
    } else if (a.state === "idle" && before === "working") {
      cues.push("completion");
    }
  }

  return { cues, next };
}
