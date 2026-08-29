import { useCallback, useEffect, useRef, useState } from "react";
import { isDictatable, micPosition, spliceTranscript, MIC_SIZE, MIC_GAP } from "../lib/dictation";
import { toast } from "./toast";

// Click-to-talk for every text field in the app, from one place.
//
// Rather than bolting a button onto each of the fifteen-odd inputs — each with
// its own layout — a single mic follows the focus. Whatever text field you're in
// gets the mic in its corner, including any field added later.
//
// The words go in through the native value setter plus a synthetic `input`
// event, so React's onChange fires exactly as if you'd typed them. Every field
// keeps its own behaviour: Enter-to-send in the drawer, commit-on-blur on the
// board, ⌘↵ to post a comment.

type Field = HTMLInputElement | HTMLTextAreaElement;

/** The vendor-prefixed Web Speech API, as much of it as we use. */
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as Record<string, new () => Recognition>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Set a field's value the way a keystroke would. React installs its own value
 * setter on the element, so assigning `el.value` directly leaves its state stale
 * and the next render throws the dictated text away — going through the
 * prototype setter and dispatching `input` is what makes onChange fire.
 */
function typeInto(el: Field, value: string, cursor: number): void {
  // Branch on tagName, the same way isDictatable decides what a field is.
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.setSelectionRange(cursor, cursor);
}

export function Dictation() {
  const [target, setTarget] = useState<Field | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [listening, setListening] = useState(false);

  const recRef = useRef<Recognition | null>(null);
  // Where dictation began: the field's text and cursor at the moment the mic
  // opened. Every interim result re-splices the running transcript into THIS,
  // so a phrase refines in place instead of stacking up half-heard drafts.
  const anchorRef = useRef<{ value: string; start: number; end: number } | null>(null);
  const supported = useRef(!!recognitionCtor()).current;

  const stop = useCallback(() => {
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
  }, []);

  // ---- follow the focus ---------------------------------------------------
  // Read activeElement a tick later: during focusout the browser hasn't settled
  // on the next element yet, and mid-flight it reads as <body>.
  useEffect(() => {
    if (!supported) return;
    const check = () => {
      const el = document.activeElement as Field | null;
      setTarget(isDictatable(el) ? el : null);
    };
    const soon = () => setTimeout(check, 0);
    document.addEventListener("focusin", soon);
    document.addEventListener("focusout", soon);
    check();
    return () => {
      document.removeEventListener("focusin", soon);
      document.removeEventListener("focusout", soon);
    };
  }, [supported]);

  // Leaving a field ends its dictation — the anchor belonged to that field.
  useEffect(() => { stop(); }, [target, stop]);

  // ---- stay pinned to it --------------------------------------------------
  useEffect(() => {
    if (!target) { setPos(null); return; }
    const measure = () => setPos(micPosition(target.getBoundingClientRect()));

    // Reserve the mic's width inside the field while it's focused, so neither
    // the placeholder nor the text you dictate ends up sliding underneath it.
    // Restored on blur, so an unfocused field looks exactly as it always did.
    const ownPadding = target.style.paddingRight;
    const gap = parseFloat(getComputedStyle(target).paddingRight) || 0;
    target.style.paddingRight = `${gap + MIC_SIZE + MIC_GAP * 2}px`;

    measure();
    // Capture phase so the mic tracks scrolling containers (the drawer, the
    // board, a modal body), not just the window.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    // The drawer's textarea grows as you type, and typing moves nothing else.
    target.addEventListener("input", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      target.removeEventListener("input", measure);
      ro.disconnect();
      target.style.paddingRight = ownPadding;
    };
  }, [target]);

  // ---- listen -------------------------------------------------------------
  const start = useCallback(() => {
    const el = target;
    const Ctor = recognitionCtor();
    if (!el || !Ctor) return;

    const end = el.selectionEnd ?? el.value.length;
    anchorRef.current = { value: el.value, start: el.selectionStart ?? end, end };

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";

    rec.onresult = (e) => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      let heard = "";
      for (let i = 0; i < e.results.length; i++) heard += e.results[i]![0]!.transcript;
      const { value, cursor } = spliceTranscript(anchor.value, anchor.start, anchor.end, heard.trim());
      typeInto(el, value, cursor);
    };
    rec.onerror = (e) => {
      // Silence on the mic isn't a failure worth a toast — it just times out.
      if (e.error === "no-speech" || e.error === "aborted") return;
      toast(e.error === "not-allowed"
        ? "Microphone blocked — allow it for this site in your browser settings"
        : `Dictation stopped: ${e.error}`);
    };
    rec.onend = () => { recRef.current = null; setListening(false); };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      toast("Could not start dictation");
      recRef.current = null;
    }
  }, [target]);

  const toggle = useCallback(() => { listening ? stop() : start(); }, [listening, start, stop]);

  // Alt+D toggles dictation on the focused field, so you never have to leave the
  // keyboard to start talking. Matched on e.code because on mac Alt+D types "∂".
  useEffect(() => {
    if (!supported) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyD" && target) {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && listening) stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [supported, target, listening, toggle, stop]);

  // Stop cleanly if the app unmounts mid-sentence.
  useEffect(() => () => recRef.current?.stop(), []);

  if (!supported || !target || !pos) return null;

  return (
    <button
      className={`mic-btn${listening ? " listening" : ""}`}
      style={{ left: pos.left, top: pos.top, width: MIC_SIZE, height: MIC_SIZE }}
      title={listening ? "Stop dictating (Esc)" : "Dictate into this field (Alt+D)"}
      aria-label={listening ? "Stop dictating" : "Dictate into this field"}
      aria-pressed={listening}
      // Keep the focus in the field: a click that stole it would take the cursor
      // — and the anchor — with it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
    >
      🎤
    </button>
  );
}
