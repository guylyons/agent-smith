import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
  /** Indices into `subtitle` to highlight — the characters the query matched,
   *  when this row earned its place on body text rather than its title. */
  marks?: number[];
  activate: () => void;
};

/** Render `text` with the characters at `marks` emphasised. Marks are ascending
 *  and in range by construction (matchSnippet maps them onto the snippet it
 *  returns), so this just walks them in order. */
function Marked({ text, marks }: { text: string; marks?: number[] }) {
  if (!marks?.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    if (m > at) out.push(<Fragment key={`t${at}`}>{text.slice(at, m)}</Fragment>);
    out.push(<b className="palette-mark" key={`m${m}`}>{text[m]}</b>);
    at = m + 1;
  }
  if (at < text.length) out.push(<Fragment key={`t${at}`}>{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

/** The palette's live result count: silent while browsing, else how many
 *  rows the query found, so a screen reader hears the list change. */
export function paletteStatus(count: number, query: string): string {
  if (!query.trim()) return "";
  if (count === 0) return "Nothing found.";
  return `${count} result${count === 1 ? "" : "s"}`;
}

/** The DOM id of row `i`, for aria-activedescendant. */
const optionId = (i: number) => `palette-opt-${i}`;

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
      // A body hit shows the matching text in place of the static subtitle —
      // otherwise the row gives no clue why the query landed on it.
      subtitle: r.snippet ?? r.subtitle,
      marks: r.marks,
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
    <ModalBackdrop className="palette-backdrop" onClose={onClose} label="Find">
      <div className="win palette" onKeyDown={onKeyDown}>
        <div className="palette-inputrow">
          <span className="palette-prompt">⌕</span>
          <input
            ref={inputRef}
            className="reply-input palette-input"
            aria-label="Find a ticket, desk, or chat"
            // Focus stays in the box while the arrows move a highlight through
            // the list; activedescendant tells a screen reader which row that is.
            role="combobox"
            aria-autocomplete="list"
            aria-controls="palette-list"
            aria-expanded={entries.length > 0}
            aria-activedescendant={entries.length ? optionId(sel) : undefined}
            placeholder="Find a ticket, desk, or chat…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="sr-only" role="status">{paletteStatus(entries.length, query)}</div>
        <div className="palette-list" ref={listRef} id="palette-list" role="listbox" aria-label="Results">
          {entries.length === 0 && (
            <div className="msg-empty" aria-hidden="true">{query.trim() ? "Nothing found." : "Type to search everything."}</div>
          )}
          {entries.map((en, i) => {
            const group = groupFor(i);
            return (
              <div key={en.key} role="none">
                {group && <div className="pix palette-group" aria-hidden="true">{group}</div>}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === sel}
                  data-idx={i}
                  className={`palette-row${i === sel ? " on" : ""}`}
                  onMouseMove={() => setSel(i)}
                  onClick={en.activate}
                >
                  <span className="palette-icon" aria-hidden="true">{en.icon}</span>
                  <span className="palette-title">{en.title}</span>
                  {en.subtitle && (
                    <span className={`palette-sub${en.marks ? " is-snippet" : ""}`}>
                      <Marked text={en.subtitle} marks={en.marks} />
                    </span>
                  )}
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
