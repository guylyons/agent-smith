import type { AgentStatus } from "../schema";
import { isDoneColumn, type Board } from "../lib/board";

// Which cue to play. Kept separate from the WebAudio synth (sounds.ts) so this
// transition logic stays pure and unit-testable.
export type SoundCue = "completion" | "question" | "permission" | "move" | "celebrate";

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

// --- board moves (a card changing column) ---------------------------------

// Per-card column carried between snapshots, keyed by card id.
export type PrevCols = Map<string, string>;

export type CardMove = { cardId: string; title: string; from: string; to: string };
export type BoardMoveDiff = { moves: CardMove[]; next: PrevCols };

/**
 * Diff the previous per-card columns against the current board and report which
 * cards changed column. Pure — no audio, no DOM — so the caller (Notifier) maps
 * each move to a sound and, for a completion, the party toast.
 *
 * `primed` guards the first populated snapshot exactly like soundTransitions: on
 * the baseline we record columns without reporting, so cards already placed on
 * load don't sound. A card unseen in `prev` (freshly added) is recorded but
 * never counts as a move.
 */
export function boardMoves(prev: PrevCols, board: Board, primed: boolean): BoardMoveDiff {
  const next: PrevCols = new Map();
  const moves: CardMove[] = [];

  for (const card of board.cards) {
    const before = prev.get(card.id);
    next.set(card.id, card.columnId);
    if (!primed || before === undefined || before === card.columnId) continue;
    moves.push({ cardId: card.id, title: card.title, from: before, to: card.columnId });
  }

  return { moves, next };
}

/** A move that finishes a task — into a column whose stage is done. */
export function isCompletion(move: CardMove, board: Board): boolean {
  return isDoneColumn(board, move.to);
}
