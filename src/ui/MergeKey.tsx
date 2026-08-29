import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMergeState, mergeCard, type MergeState } from "./actions";
import { playKeyClick } from "./sounds";
import { toast } from "./toast";

// A real key on the ticket: once the card's agent has COMMITTED work on its
// branch, a keycap rises out of the card and landing that work is one press.
// Nothing to merge = no key at all, so an unfinished ticket isn't cluttered
// with a button that can't do anything.
//
// It arms before it fires, like the kill button on a desk: a merge writes to
// the user's main checkout, and one stray click shouldn't do that. The first
// press latches the cap down and swaps the legend to CONFIRM; the second one
// merges. It relaxes on its own after a few seconds, or when focus leaves it.

/** How long an armed key waits for the confirming press before relaxing. Long
 *  enough to read the branch name on the plate beside it and then press. */
const ARM_MS = 8000;

/** How often the git state behind the key is re-read while the card is open —
 *  the agent may commit (or dirty the tree) while you're looking at it. */
const POLL_MS = 10_000;

type Phase = "idle" | "armed" | "working" | "merged";

/** Read the card's merge state now, and keep it fresh while the card is open. */
function useMergeState(cardId: string, enabled: boolean) {
  const [state, setState] = useState<MergeState | null>(null);

  const reload = useCallback(async () => {
    setState(await fetchMergeState(cardId));
  }, [cardId]);

  useEffect(() => {
    if (!enabled) { setState(null); return; }
    let alive = true;
    const tick = async () => {
      const s = await fetchMergeState(cardId);
      if (alive) setState(s);
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [cardId, enabled]);

  return { state, reload };
}

export function MergeKey({ cardId, hasAssignee }: { cardId: string; hasAssignee: boolean }) {
  const { state, reload } = useMergeState(cardId, hasAssignee);
  const [phase, setPhase] = useState<Phase>("idle");
  // Held down: by the pointer, or by a held Enter/Space — a keyboard press
  // should push the cap in for as long as the key is down, same as a finger.
  const [down, setDown] = useState(false);
  const [landed, setLanded] = useState<{ branch: string; base: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Disarm on a timeout, and whenever the card's git state changes underneath
  // an armed key — what you armed is not what you'd be merging any more.
  useEffect(() => {
    if (phase !== "armed") return;
    timer.current = setTimeout(() => setPhase("idle"), ARM_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [phase, state?.ahead, state?.branch]);

  // A merged key stays latched with its own legend for the life of the modal:
  // the state behind it now says "nothing to merge", and blinking the key out
  // of existence is a worse answer than showing what just happened.
  if (!landed && (!state || !state.committed)) return null;

  const ready = !!state?.ready && phase !== "working";
  const summary = landed
    ? `${landed.branch} is in ${landed.base}`
    : state ? `${state.ahead} commit${state.ahead === 1 ? "" : "s"} on ${state.branch} → ${state.base}` : "";

  async function fire() {
    setPhase("working");
    const r = await mergeCard(cardId);
    if (r.ok && r.branch && r.base) {
      setLanded({ branch: r.branch, base: r.base });
      setPhase("merged");
      toast(`Merged ${r.branch} into ${r.base}`);
    } else {
      setPhase("idle");
      void reload(); // the refusal usually IS the state changing (dirty tree, busy trunk)
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
    <div className={`mergekey phase-${phase}${ready ? "" : " is-held"}`}>
      <div className="mergekey-deck">
        <span className={`mergekey-led${ready || phase !== "idle" ? " on" : ""}`} aria-hidden="true" />
        <button
          type="button"
          className={`mergekey-cap${pushed ? " is-down" : ""}`}
          disabled={phase === "merged" || (!ready && phase !== "working")}
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
  );
}
