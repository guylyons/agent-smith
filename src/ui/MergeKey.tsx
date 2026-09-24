import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMergeRead, mergeCard, type MergeState } from "./actions";
import { mergeGate, mergeRefusal, previewKey } from "../lib/mergeRace";
import { mergeHint, type MergeRead } from "../lib/mergeHint";
import type { Board, Card } from "../lib/board";
import { playKeyClick } from "./sounds";
import { MergePreview } from "./MergePreview";
import { toast, toastError } from "./toast";

// A real key on the ticket: once the card's agent has COMMITTED work on its
// branch, a keycap rises out of the card and landing that work is one press.
// Nothing to merge = no key at all, so an unfinished ticket isn't cluttered
// with a button that can't do anything.
//
// It arms before it fires, like the kill button on a desk: a merge writes to
// the user's main checkout, and one stray click shouldn't do that. The first
// press latches the cap down and swaps the legend to CONFIRM; the second one
// merges. It relaxes on its own after a few seconds, or when focus leaves it.
//
// No key on a card waiting in Review or Done usually means its branch landed
// some other way (merged by hand, worktree gone). Then one plain line says so,
// with a button that moves the card on to the merged column (see mergeHint).

/** How long an armed key waits for the confirming press before relaxing. Long
 *  enough to read the branch name on the plate beside it and then press. */
const ARM_MS = 8000;

/** How often the git state behind the key is re-read while the card is open —
 *  the agent may commit (or dirty the tree) while you're looking at it. */
const POLL_MS = 10_000;

type Phase = "idle" | "armed" | "working" | "merged";

/** Read the card's merge state now, and keep it fresh while the card is open. */
function useMergeState(cardId: string, enabled: boolean) {
  const [read, setRead] = useState<MergeRead>({ kind: "loading" });
  const state = read.kind === "state" ? read.state : null;

  // Re-read now and hand the fresh state back, for the confirming press to
  // decide on. A failed read keeps what the key already shows — a blip
  // shouldn't blink the key out of existence under the pointer.
  const reload = useCallback(async () => {
    const r = await fetchMergeRead(cardId);
    if ("state" in r) { setRead({ kind: "state", state: r.state }); return r.state; }
    return null;
  }, [cardId]);

  useEffect(() => {
    if (!enabled) { setRead({ kind: "loading" }); return; }
    let alive = true;
    const tick = async () => {
      const r = await fetchMergeRead(cardId);
      if (!alive) return;
      // A failed poll under a live key keeps the key, as reload does.
      if ("error" in r) setRead((prev) => (prev.kind === "state" && prev.state.committed ? prev : { kind: "error", message: r.error }));
      else setRead({ kind: "state", state: r.state });
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [cardId, enabled]);

  return { read, state, reload };
}

export function MergeKey({ board, card, hasAssignee, onMove }: {
  board: Board; card: Card; hasAssignee: boolean;
  /** move the card to this column (the modal's own optimistic move) */
  onMove: (columnId: string) => void;
}) {
  const cardId = card.id;
  // A card in Review or Done is read even with no assignee, so the line
  // below can say why there's no key rather than show nothing.
  const waiting = mergeHint(board, card, { kind: "loading" }) !== null;
  const { read, state, reload } = useMergeState(cardId, hasAssignee || waiting);
  const [phase, setPhase] = useState<Phase>("idle");
  // Held down: by the pointer, or by a held Enter/Space — a keyboard press
  // should push the cap in for as long as the key is down, same as a finger.
  const [down, setDown] = useState(false);
  const [landed, setLanded] = useState<{ branch: string; base: string } | null>(null);
  // The tip SHA of the WHAT WILL LAND list on screen — what the human reviewed.
  const [shownTip, setShownTip] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Disarm on a timeout, and whenever the card's git state changes underneath
  // an armed key — what you armed is not what you'd be merging any more.
  useEffect(() => {
    if (phase !== "armed") return;
    timer.current = setTimeout(() => setPhase("idle"), ARM_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [phase, state?.tip, state?.branch]);

  // A merged key stays latched with its own legend for the life of the modal:
  // the state behind it now says "nothing to merge", and blinking the key out
  // of existence is a worse answer than showing what just happened.
  if (!landed && (!state || !state.committed)) {
    const hint = mergeHint(board, card, read);
    return hint ? <MergeHintLine hint={hint} onMove={onMove} /> : null;
  }

  const ready = !!state?.ready && phase !== "working";
  const summary = landed
    ? `${landed.branch} is in ${landed.base}`
    : state ? `${state.ahead} commit${state.ahead === 1 ? "" : "s"} on ${state.branch} → ${state.base}` : "";

  async function fire() {
    setPhase("working");
    // What the human reviewed: the preview's tip, or the key's own if the
    // preview couldn't be read. The server refuses the merge if the branch no
    // longer points there, so an unseen commit can't land.
    const seen = shownTip ?? state?.tip;
    // The state the key lit up on can be up to a poll old, and another card's
    // merge may have landed since. Re-read it before sending, and if it moved,
    // say so here instead of sending a merge the server will refuse.
    const gate = mergeGate(await reload(), seen);
    if (!gate.go) {
      setPhase("idle");
      toastError(gate.message);
      return;
    }
    const r = await mergeCard(cardId, seen);
    if (r.ok && r.branch && r.base) {
      setLanded({ branch: r.branch, base: r.base });
      setPhase("merged");
      toast(`Merged ${r.branch} into ${r.base}`);
    } else {
      setPhase("idle");
      // The refusal usually IS the state changing in the moment between our
      // check and the queue (dirty tree, busy trunk) — read it again so the
      // key and the toast both say what's in the way now.
      toastError(mergeRefusal(r.error ?? "could not merge", await reload()));
    }
  }

  function press() {
    if (phase === "working" || phase === "merged") return;
    if (!ready) return;
    if (phase === "idle") { setPhase("armed"); return; }
    void fire();
  }

  const legend = phase === "merged" ? "MERGED"
    : phase === "working" ? "MERGING"
    : phase === "armed" ? "CONFIRM"
    : "MERGE";

  const label = phase === "armed"
    ? `Confirm: merge ${state?.branch} into ${state?.base}`
    : phase === "merged" ? `Merged ${landed?.branch} into ${landed?.base}`
    : ready ? `Merge ${state?.branch} into ${state?.base}`
    : `Cannot merge yet — ${state?.blocked ?? ""}`;

  // The cap is pushed in while held, while armed (it stays latched down so the
  // armed state is felt as well as read), and for the whole merge.
  const pushed = down || phase === "armed" || phase === "working" || phase === "merged";

  // An armed key disarms on its timer or when focus leaves it — deliberately
  // NOT when the pointer wanders off the housing. An armed cap sits 8px lower,
  // so arming it can slide the cap out from under a stationary pointer, and
  // disarming on that would break the two-press gesture it exists to enforce.
  return (
    <>
    {/* What pressing the key would land, while there's still something to. */}
    {!landed && state && <MergePreview cardId={cardId} refresh={previewKey(state)} onShown={setShownTip} />}
    <div className={`mergekey phase-${phase}${ready ? "" : " is-held"}`}>
      <div className="mergekey-deck">
        <span className={`mergekey-led${ready || phase !== "idle" ? " on" : ""}`} aria-hidden="true" />
        <button
          type="button"
          className={`mergekey-cap${pushed ? " is-down" : ""}`}
          // aria-disabled, not disabled: a disabled button drops focus to the
          // page, and the key goes dead under the cursor the moment it merges.
          // press() already ignores it when it can't fire.
          aria-disabled={phase === "merged" || (!ready && phase !== "working")}
          aria-label={label}
          title={label}
          onMouseDown={() => { if (ready) { setDown(true); playKeyClick(true); } }}
          onMouseUp={() => { if (down) { setDown(false); playKeyClick(false); } }}
          onMouseLeave={() => setDown(false)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.repeat && ready) { setDown(true); playKeyClick(true); }
          }}
          onKeyUp={(e) => {
            if ((e.key === "Enter" || e.key === " ") && down) { setDown(false); playKeyClick(false); }
          }}
          onBlur={() => { setDown(false); setPhase((p) => (p === "armed" ? "idle" : p)); }}
          onClick={press}
        >
          <span className="mergekey-top">
            <span className="mergekey-face">
              <span className="mergekey-legend">{legend}</span>
              <span className="mergekey-sub">
                {phase === "armed" ? "press again" : phase === "merged" ? "✓ landed" : `↳ ${state?.base ?? "trunk"}`}
              </span>
            </span>
          </span>
        </button>
        <div className="mergekey-plate">
          <span className="pix mergekey-caption">{summary}</span>
          {!ready && phase === "idle" && state?.blocked && (
            <span className="mergekey-why">{state.blocked}</span>
          )}
          {phase === "armed" && <span className="mergekey-why armed">press again to land it on {state?.base}</span>}
        </div>
      </div>
    </div>
    </>
  );
}

/** The one line under a card with no MERGE key, and the button that moves it
 *  on. Live region so a screen reader hears "Checking…" turn into the answer. */
function MergeHintLine({ hint, onMove }: { hint: NonNullable<ReturnType<typeof mergeHint>>; onMove: (columnId: string) => void }) {
  const to = hint.moveTo;
  return (
    <div className={`mergehint tone-${hint.tone}`}>
      <p className="mergehint-text" role="status" aria-live="polite">{hint.text}</p>
      {to && (
        <button
          type="button"
          className="pix mergehint-move"
          title={`Move this card to ${to.name}`}
          onClick={() => { onMove(to.id); toast(`Moved to ${to.name}`); }}
        >→ MOVE TO {to.name.toUpperCase()}</button>
      )}
    </div>
  );
}
