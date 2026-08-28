import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "../lib/snapshot";
import { buildSearchItems, searchItems, type SearchItem } from "../lib/search";
import { fetchChatSearch, type ChatHit } from "./actions";
import { openCard, openAgent } from "./nav";
import { ModalBackdrop } from "./Backdrop";

// One selectable row in the palette. `activate` is what Enter/click does; the
// flat entry list lets a single arrow-key index run across cards, agents and
// chat snippets alike.
type Entry = {
  key: string;
  group: string;
  icon: string;
  title: string;
  subtitle?: string;
  activate: () => void;
};

const KIND_ICON: Record<SearchItem["kind"], string> = { card: "▤", agent: "◈" };

export function CommandPalette({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState<ChatHit[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Cards + agents come straight from the live snapshot — no round-trip, so the
  // list is instant as you type.
  const items = useMemo(() => buildSearchItems(snap), [snap]);
  const results = useMemo(() => searchItems(items, query, 20), [items, query]);

  // Chat snippets need the server (it reads transcripts). Debounce so a fast
  // typist doesn't fire a request per keystroke, and require 2+ chars so the
  // whole transcript corpus isn't scanned for a single letter.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setChats([]); return; }
    let alive = true;
    const id = setTimeout(async () => {
      const hits = await fetchChatSearch(q);
      if (alive) setChats(hits);
    }, 180);
    return () => { alive = false; clearTimeout(id); };
  }, [query]);

  // Build the flat, ordered entry list the arrow keys walk. `results` is ranked
  // across kinds. When browsing (no query) the natural order is already cards
  // then agents, so label them TICKETS / DESKS. With an active query, keep the
  // pure relevance order (the best match wins regardless of kind) under one
  // RESULTS header — the per-row icon still shows each kind. Chats are a separate
  // async source, always trailing under their own header.
  const browsing = !query.trim();
  const entries: Entry[] = useMemo(() => {
    const local: Entry[] = results.map((r) => ({
      key: `${r.kind}:${r.id}`,
      group: browsing ? (r.kind === "card" ? "TICKETS" : "DESKS") : "RESULTS",
      icon: KIND_ICON[r.kind],
      title: r.title,
      subtitle: r.subtitle,
      activate: () => { r.kind === "card" ? openCard(r.id) : openAgent(r.id); onClose(); },
    }));
    const chatEntries: Entry[] = chats.map((c) => ({
      key: `chat:${c.sessionId}`,
      group: "CHATS",
      icon: "💬",
      title: c.name,
      subtitle: c.snippet,
      activate: () => { openAgent(c.sessionId); onClose(); },
    }));
    return [...local, ...chatEntries];
  }, [results, chats, browsing, onClose]);

  // Keep the selection in range as results shrink/grow; snap back to the top when
  // the query changes.
  useEffect(() => { setSel(0); }, [query]);
  useEffect(() => { if (sel >= entries.length) setSel(Math.max(0, entries.length - 1)); }, [entries.length, sel]);

  // Keep the highlighted row scrolled into view under arrow-key navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (entries.length ? (s + 1) % entries.length : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (entries.length ? (s - 1 + entries.length) % entries.length : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); entries[sel]?.activate(); }
  }

  // Render a section header only when the group changes from the row above, so
  // each label appears once over its contiguous run.
  let lastGroup = "";
  const groupFor = (i: number): string | null => {
    const group = entries[i]!.group;
    if (group === lastGroup) return null;
    lastGroup = group;
    return group;
  };

  return (
    <ModalBackdrop className="palette-backdrop" onClose={onClose}>
      <div className="win palette" onKeyDown={onKeyDown}>
        <div className="palette-inputrow">
          <span className="palette-prompt">⌕</span>
          <input
            ref={inputRef}
            className="reply-input palette-input"
            placeholder="Find a ticket, desk, or chat…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {entries.length === 0 && (
            <div className="msg-empty">{query.trim() ? "Nothing found." : "Type to search everything."}</div>
          )}
          {entries.map((en, i) => {
            const group = groupFor(i);
            return (
              <div key={en.key}>
                {group && <div className="pix palette-group">{group}</div>}
                <div
                  data-idx={i}
                  className={`palette-row${i === sel ? " on" : ""}`}
                  onMouseMove={() => setSel(i)}
                  onClick={en.activate}
                >
                  <span className="palette-icon">{en.icon}</span>
                  <span className="palette-title">{en.title}</span>
                  {en.subtitle && <span className="palette-sub">{en.subtitle}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot pix">↑↓ move · ↵ open · esc close</div>
      </div>
    </ModalBackdrop>
  );
}
