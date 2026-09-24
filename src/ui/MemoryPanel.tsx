import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MemoryNode } from "../lib/memory";
import { ModalBackdrop } from "./Backdrop";
import { fetchMemory, forgetMemoryAction } from "./actions";
import { neighbourAfter } from "./archiveView";
import { MEMORY_LIMIT, MEMORY_SCOPES, cardIdsOf, countNote, linkLabel, memoryDay, memoryQuery, newestFirst, type MemoryScope } from "./memoryList";
import { openCard } from "./nav";
import { toast } from "./toast";

// The team memory, for the human to read: what agents recorded with
// memory_add (and, on request, the cards), newest first, filtered through
// GET /memory?q=. Read-only but for FORGET, which asks first. A card link
// closes the dialog and opens the card.
export function MemoryPanel({ cards, onClose }: {
  /** the board's cards, to name and open card links */
  cards: { id: string; num?: number; title: string }[];
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState<MemoryScope>("facts");
  const [query, setQuery] = useState(() => memoryQuery("", "facts"));
  const [nodes, setNodes] = useState<MemoryNode[] | "error" | null>(null);
  const [reload, setReload] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusWant, setFocusWant] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Typing settles for a beat before it asks the server; the kind picker asks at once.
  useEffect(() => {
    const t = setTimeout(() => setQuery(memoryQuery(text, scope)), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    let live = true;
    setNodes((n) => (n === "error" ? null : n));
    void fetchMemory(query, MEMORY_LIMIT).then((r) => { if (live) setNodes(r ? newestFirst(r) : "error"); });
    return () => { live = false; };
  }, [query, reload]);

  useLayoutEffect(() => {
    if (!focusWant) return;
    const el = focusWant === "filter" ? filterRef.current : listRef.current?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusWant)}"]`);
    if (el) { el.focus(); setFocusWant(null); }
  });

  function pickScope(s: MemoryScope) {
    setScope(s);
    setQuery(memoryQuery(text, s));
  }

  function open(cardId: string) {
    onClose();
    openCard(cardId);
  }

  async function doForget(n: MemoryNode) {
    if (busy || !Array.isArray(nodes)) return;
    setBusy(true);
    const ok = await forgetMemoryAction(n.id);
    setBusy(false);
    setConfirming(null);
    if (!ok) { setFocusWant(`forget:${n.id}`); return; }
    const next = neighbourAfter(nodes.map((x) => x.id), n.id);
    setNodes(nodes.filter((x) => x.id !== n.id));
    setFocusWant(next ? `row:${next}` : "filter");
    toast(`Forgot "${n.title}"`);
  }

  function cancel(id: string) {
    setConfirming(null);
    setFocusWant(`forget:${id}`);
  }

  const list = Array.isArray(nodes) ? nodes : [];

  return (
    <ModalBackdrop onClose={onClose} labelledBy="memory-title">
      <aside className="win settings memory-panel">
        <div className="settings-head">
          <span id="memory-title" className="pix settings-title">TEAM MEMORY</span>
          <button className="deskbtn" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="memory-controls">
            <label className="memory-field">
              <span className="pix settings-label">FILTER</span>
              <input ref={filterRef} type="search" className="memory-input" value={text} autoFocus
                placeholder="words, or person:NAME, file:src/x.ts" onChange={(e) => setText(e.target.value)} />
            </label>
            <label className="memory-field">
              <span className="pix settings-label">SHOW</span>
              <select className="settings-select memory-scope" value={scope} onChange={(e) => pickScope(e.target.value as MemoryScope)}>
                {MEMORY_SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          </div>
          <div className="settings-hint memory-count" role="status">
            {nodes === null ? "Loading…" : nodes === "error" ? "" : countNote(list.length)}
          </div>
          {nodes === "error" && (
            <div className="memory-error" role="alert">
              <span>Couldn't load the memory.</span>
              <button className="deskbtn" onClick={() => setReload((n) => n + 1)}>RETRY</button>
            </div>
          )}
          <div ref={listRef}>
            <ul className="memory-list" aria-label="Memory entries">
              {list.map((n) => {
                const cardIds = cardIdsOf(n);
                const others = (n.links ?? []).filter((l) => !l.startsWith("card:"));
                const fact = n.kind !== "card";
                return (
                  <li key={n.id} className={`memory-row memory-${n.kind}`} data-focus={`row:${n.id}`} tabIndex={-1}>
                    <div className="memory-meta">
                      <span className="memory-kind">{n.kind.toUpperCase()}</span>
                      <span>{memoryDay(n)}</span>
                      {n.by && <span>by {n.by}</span>}
                    </div>
                    <div className="memory-title">{n.title}</div>
                    {n.body && (
                      <div className="memory-body">
                        {n.body}
                        {n.compact && <span className="memory-compact"> (shortened with age)</span>}
                      </div>
                    )}
                    {cardIds.length > 0 && (
                      <div className="memory-links">
                        <span className="memory-linkhead">{cardIds.length === 1 ? "Card:" : "Cards:"}</span>
                        {cardIds.map((id) => {
                          const l = linkLabel(id, cards);
                          return l.onBoard
                            ? <button key={id} className="memory-cardlink" title="Open this card" onClick={() => open(id)}>{l.text}</button>
                            : <span key={id} className="memory-link">{l.text}</span>;
                        })}
                      </div>
                    )}
                    {(others.length > 0 || (n.tags?.length ?? 0) > 0) && (
                      <div className="memory-links">
                        {others.length > 0 && <span className="memory-linkhead">Links:</span>}
                        {others.map((l) => <span key={l} className="memory-link">{l}</span>)}
                        {n.tags?.length ? <span className="memory-linkhead">Tags:</span> : null}
                        {n.tags?.map((t) => <span key={t} className="memory-link">{t}</span>)}
                      </div>
                    )}
                    {fact && confirming !== n.id && (
                      <div className="memory-actions">
                        <button className="deskbtn" data-focus={`forget:${n.id}`} aria-label={`Forget "${n.title}"`} onClick={() => setConfirming(n.id)}>FORGET</button>
                      </div>
                    )}
                    {fact && confirming === n.id && (
                      <div className="memory-actions" role="group" aria-labelledby={`forget-q-${n.id}`}
                        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); cancel(n.id); } }}>
                        <span id={`forget-q-${n.id}`}>Forget this for the whole team? It can't be undone.</span>
                        <button className="deskbtn danger" aria-disabled={busy} onClick={() => void doForget(n)}>{busy ? "FORGETTING…" : "FORGET"}</button>
                        <button className="deskbtn" autoFocus disabled={busy} onClick={() => cancel(n.id)}>CANCEL</button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </aside>
    </ModalBackdrop>
  );
}
