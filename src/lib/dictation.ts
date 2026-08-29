// The pure half of click-to-talk: which fields accept dictation, where the
// spoken words land in one, and where the mic button sits over it. Kept out of
// the component so it can be tested without a DOM.

/** Everything the predicate needs off a focused node. */
export type FieldLike = { tagName: string; type?: string; disabled?: boolean; readOnly?: boolean };

/** A field's box on screen — a `DOMRect` satisfies this. */
export type RectLike = { left: number; top: number; width: number; height: number };

export const MIC_SIZE = 22;
export const MIC_GAP = 4;

// Input types that hold prose you'd plausibly speak AND support the selection
// API — dictation has to know where the cursor is to splice words in. That rules
// out `email` and `number`, where browsers throw on setSelectionRange. Files,
// sliders, dates and above all passwords are left alone for the obvious reasons.
const SPOKEN_TYPES = new Set(["", "text", "search", "url", "tel"]);

/** Can you dictate into this focused element? */
export function isDictatable(el: FieldLike | null | undefined): boolean {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return SPOKEN_TYPES.has((el.type ?? "").toLowerCase());
}

/**
 * Drop `transcript` into `value` at the cursor, replacing any selection and
 * spacing it off from the words either side.
 *
 * Callers keep the anchor (value + selection as they were when the mic started)
 * and re-splice the whole running transcript on every interim result, so a live
 * transcription refines in place instead of stacking up drafts.
 */
export function spliceTranscript(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): { value: string; cursor: number } {
  if (!transcript) return { value, cursor: selectionStart };

  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";

  return {
    value: before + lead + transcript + trail + after,
    cursor: before.length + lead.length + transcript.length,
  };
}

/** Viewport coordinates for the mic, tucked inside the field's right edge. */
export function micPosition(rect: RectLike): { left: number; top: number } {
  const short = rect.height <= MIC_SIZE + MIC_GAP * 2;
  return {
    left: rect.left + rect.width - MIC_SIZE - MIC_GAP,
    // A textarea gets the mic up in its corner, out of the way of the text; a
    // single-line input has no corner to speak of, so centre it instead.
    top: short ? rect.top + (rect.height - MIC_SIZE) / 2 : rect.top + MIC_GAP,
  };
}
