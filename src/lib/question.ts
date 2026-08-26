// Shared "did the assistant end its turn on a question?" heuristic, used by both
// the hook writer and the transcript scanner so they never disagree about a
// session's waiting/question state.
export function endsWithQuestion(text: string | null | undefined): boolean {
  return !!text && /\?\s*$/.test(text.trim());
}
