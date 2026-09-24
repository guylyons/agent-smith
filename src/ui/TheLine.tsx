import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, RefObject } from "react";
import type { AgentStatus } from "../schema";
import type { Board, Column, Card, Stage } from "../lib/board";
import {
  renameColumn, setInstruction, setColumnStage, deleteColumn, reorderColumn,
  deleteCard, restoreCard, moveCard, restoreColumn, cardMoveTarget, STAGES,
  mergeBlockers, mergeBlockReason, mergedColumn,
} from "../lib/board";
import {
  addColumnAction, renameColumnAction, setInstructionAction, setColumnStageAction, deleteColumnAction,
  reorderColumnAction, restoreColumnAction, addCardAction, addScrumCardAction, moveCardAction,
  deleteCardAction, restoreCardAction, ME,
} from "./actions";
import { toast } from "./toast";
import { onOpenCard, type CardFocus } from "./nav";
import { CardModal, type SpawnSeed } from "./CardModal";
import { Sprite } from "./Sprite";
import { ArchiveBar } from "./ArchiveBar";
import { stackMaxHeight } from "./stackCap";
import { loadRecentFolders, projectFolder } from "./recentFolders";
import { findLiveAssignee } from "../lib/sendTaskReady";
import { displayState } from "../lib/liveness";
import { cardRef } from "../lib/ticket";
import {
  canPrime, loadMarks, markCardRead, newestCommentAt, primeMarks, saveMarks,
  unreadCommentCount,
} from "./cardUnread";
import {
  knownRepos, filterCards, filterRepo, dropIndex, visibleMoveTarget, loadRepoFilter, saveRepoFilter,
  parseRepoFilter, serialiseRepoFilter, scrumTarget, newlyHidden, cardInFilter, type RepoFilter,
} from "./repoFilter";
import { refocusAfterMove, moveSettled, cardButton, type PendingFocus } from "./moveFocus";

const CARD_MIME = "application/x-line-card";
/** How long a card you touched stays watched for leaving the filtered view. */
const WATCH_MS = 5 * 60_000;
const COL_MIME = "application/x-line-column";

// A board edit: the pure op to show immediately, and the one scoped server call
// that makes it real. `send` is optional — an op whose id the SERVER generates
// (adding a card or a column) has nothing to show optimistically and passes the
// call alone, letting the SSE echo bring the new thing back.
type Mutate = (fn: ((b: Board) => Board) | null, send: () => void) => void;

// THE LINE — a simple kanban board. Columns and cards are renamable and
// draggable; each column carries an instruction describing what to do with work
// that lands in it. The board is held in local state (seeded from the live
// snapshot) so an edit paints instantly, but what goes to the server is one
// SCOPED call naming just that edit — never the whole board. The server applies
// it against a fresh read and echoes the result back over SSE, so a rename here
// and an agent's comment there compose instead of overwriting each other.
export function TheLine({
  board: incoming, agents, lineRows, onSpawnForCard, archived = 0,
}: {
  board: Board; agents: AgentStatus[]; lineRows: number;
  /** cards in the archive, shown on the Merged column (see ArchiveBar) */
  archived?: number;
  onSpawnForCard: (task: string, cardId: string, seed?: SpawnSeed) => void;
}) {
  const [board, setBoard] = useState(incoming);
  const [addingCol, setAddingCol] = useState(false);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  // Where to land inside the open card (a notice's comment, a move's stage, a
  // fresh card's description). Lives exactly as long as that viewing.
  const [openFocus, setOpenFocus] = useState<CardFocus | null>(null);
  const showCard = (id: string | null, focus?: CardFocus) => {
    if (id) watch(id);
    setOpenCardId(id); setOpenFocus(focus ?? null);
  };

  // Cards you just made, opened or launched an agent for, and when. If the repo
  // filter starts hiding one (the server stamps a repo on spawn, say), a toast
  // says where it went instead of it vanishing silently. Kept a few minutes: a
  // card you touched an hour ago moving out of view is not news.
  const watched = useRef(new Map<string, number>());
  function watch(id: string) { watched.current.set(id, Date.now()); }

  // Adopt snapshots from the server (our own echoes, or edits from another tab
  // / an agent). Active text fields keep their own draft, so this never yanks a
  // value out from under the cursor.
  useEffect(() => { setBoard(incoming); }, [incoming]);

  // Open a card when the notification center asks (clicking a comment/move),
  // landing on the exact thing the notice was about.
  useEffect(() => onOpenCard((id, focus) => showCard(id, focus)), []);

  // Which comment threads you haven't read, and whether a baseline has ever
  // been taken. A browser with no baseline takes one from the first REAL board
  // it sees rather than flagging every card that was ever commented on — the
  // same "don't badge the world on first paint" rule the desks' unread badges
  // follow (src/ui/unread.ts). Not at mount: the board this first renders is
  // the empty default, and a baseline taken from that silences nothing.
  const [read, setRead] = useState(loadMarks);

  const mutate: Mutate = (fn, send) => {
    if (fn) setBoard((prev) => fn(prev));
    send();
  };

  // A keyboard move to another column remounts the card there and drops focus
  // to the page; put it back on the card once the board has re-rendered, until
  // the server confirms the move (see moveFocus.ts). Only a keyboard move here
  // sets it, so an agent's move never pulls focus.
  const pendingFocus = useRef<PendingFocus>(null);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const now = Date.now();
    const dropped = !document.activeElement || document.activeElement === document.body;
    const id = refocusAfterMove(pending, board, dropped, now);
    const el = id && cardButton(id);
    if (el) { el.focus(); el.scrollIntoView({ block: "nearest" }); }
    if (moveSettled(pending, incoming, now)) pendingFocus.current = null;
  }, [board, incoming]);

  function onAddColumn() {
    setAddingCol(true);
    mutate(null, () => addColumnAction("")); // blank name -> its input auto-focuses
  }

  // Which project's cards to show. Remembered per browser; it only hides cards,
  // never changes them. A remembered repo that has since left the board is still
  // offered, so the view is never stuck on a filter you can't pick your way out of.
  const [repoFilter, setRepoFilter] = useState(loadRepoFilter);
  const known = knownRepos(board, agents);
  const filterNames = known.map((k) => k.name);
  if (repoFilter.kind === "repo" && !filterNames.includes(repoFilter.repo)) filterNames.push(repoFilter.repo);
  function pickFilter(f: RepoFilter) { setRepoFilter(f); saveRepoFilter(f); }

  // A watched card the filter just started hiding: name its repo and offer the
  // way back. Both boards are judged by the current filter, so changing the
  // filter yourself never fires this.
  const prevCards = useRef<Card[]>(board.cards);
  const filterNow = useRef(repoFilter);
  filterNow.current = repoFilter;
  function announceHidden(c: Card) {
    watched.current.delete(c.id);
    toast(
      `"${c.title || "Untitled"}" is ${c.repo ? `in ${c.repo}` : "in no repo"}, so the repo filter hides it.`,
      { label: "SHOW ALL", run: () => pickFilter({ kind: "all" }) },
    );
  }
  useEffect(() => {
    const now = Date.now();
    for (const [id, at] of watched.current) if (now - at > WATCH_MS) watched.current.delete(id);
    const hidden = newlyHidden(prevCards.current, board.cards, watched.current.keys(), repoFilter);
    prevCards.current = board.cards;
    for (const c of hidden) announceHidden(c);
  }, [board.cards]);

  // The project a new scrum master card is for: the filtered repo when the view
  // is on one (so the card lands in view), else the folder you last launched an
  // agent in, else one a live agent is working in. The name and path are baked
  // into the card's starter brief; both stay editable in the card.
  const { repo: scrumRepo, folder: scrumFolder } = scrumTarget(
    repoFilter, known, projectFolder(loadRecentFolders(), agents.map((a) => a.cwd)),
  );

  // Make the project's scrum master card in the backlog and open it for editing.
  // The server keeps one per project, so pressing this again just opens it.
  function onAddScrum() {
    const col = board.columns.find((c) => c.stage === "todo") ?? board.columns[0];
    if (!col) return;
    mutate(null, () => {
      void addScrumCardAction(col.id, scrumRepo || undefined, scrumFolder || undefined).then((r) => {
        if (!r) return;
        if (r.existing) toast(`${scrumRepo || "This project"} already has a scrum master card. Opened it.`);
        showCard(r.id, r.existing ? undefined : { kind: "new" });
        // The board may already hold the card (its echo can beat this reply),
        // in which case the watcher above never sees it arrive: check it here.
        const c = prevCards.current.find((k) => k.id === r.id);
        if (c && !cardInFilter(c, filterNow.current)) announceHidden(c);
      });
    });
  }

  // The card behind an open modal, resolved fresh each render so live edits (and
  // SSE echoes) flow in. If it's deleted while open, the modal closes itself.
  const openCard = openCardId ? board.cards.find((c) => c.id === openCardId) ?? null : null;
  const openColumn = openCard ? board.columns.find((c) => c.id === openCard.columnId) : undefined;

  useEffect(() => {
    if (read.primed || !canPrime(board.cards)) return;
    setRead({ marks: primeMarks(board.cards), primed: true });
  }, [read.primed, board.cards]);

  // Having the card open IS reading it: mark the thread as it stands now, and
  // again whenever a comment lands while you're looking at it, so a card you
  // are staring at never comes back unread the moment you close it. Guarded on
  // the mark it would write, or setting state on every SSE echo would spin.
  const openNewest = openCard ? newestCommentAt(openCard) : 0;
  useEffect(() => {
    if (!openCard) return;
    setRead((r) => (r.marks[openCard.id] === openNewest ? r : { ...r, marks: markCardRead(r.marks, openCard) }));
  }, [openCardId, openNewest]);

  // Persist, dropping marks for cards that no longer exist. Only once a real
  // baseline exists — storing the empty one would count as "primed" on the next
  // load and light up the whole board.
  useEffect(() => {
    if (read.primed) saveMarks(read.marks, board.cards);
  }, [read, board.cards]);

  const unreadOn = (card: Card) => unreadCommentCount(card, read.marks, ME);

  return (
    <section className="win line">
      <div className="line-head">
        <h2 className="pix">THE LINE</h2>
        <label className="line-repo">
          <span className="pix">REPO</span>
          <select
            className={repoFilter.kind === "all" ? "" : "is-on"}
            value={serialiseRepoFilter(repoFilter)}
            title="Show only one project's cards (just in this browser; the cards don't change)"
            onChange={(e) => pickFilter(parseRepoFilter(e.target.value))}
          >
            <option value="all">All</option>
            {filterNames.map((n) => <option key={n} value={serialiseRepoFilter({ kind: "repo", repo: n })}>{n}</option>)}
            <option value="none">No repo</option>
          </select>
        </label>
        <button
          className="pix add-scrum"
          onClick={onAddScrum}
          title={scrumRepo
            ? `Make the scrum master card for ${scrumRepo}${scrumFolder ? ` (${scrumFolder})` : ""}`
            : "Make a scrum master card (no project folder yet: name it in the card)"}
        >+ SCRUM MASTER</button>
      </div>
      <p className="pix hint">DRAG WORK ACROSS YOUR STAGES · CLICK A CARD TO OPEN IT · EACH STAGE CAN INSTRUCT THE AGENT</p>
      <div className="board">
        {board.columns.map((col, i) => (
          <ColumnView
            key={col.id}
            board={board}
            agents={agents}
            mutate={mutate}
            column={col}
            index={i}
            rows={lineRows}
            autoFocusName={addingCol && i === board.columns.length - 1}
            onNamed={() => setAddingCol(false)}
            onOpenCard={showCard}
            onKeyMovedAcross={(cardId, toColumnId) => { pendingFocus.current = { cardId, toColumnId, at: Date.now() }; }}
            unreadOn={unreadOn}
            archived={archived}
            filter={repoFilter}
            newCardRepo={filterRepo(repoFilter, known)}
          />
        ))}
        <button className="pix add-col" onClick={onAddColumn} title="Add a column">+ COLUMN</button>
      </div>

      {openCard && (
        <CardModal
          key={openCard.id}
          board={board}
          card={openCard}
          columnName={openColumn?.name ?? ""}
          agents={agents}
          mutate={mutate}
          focus={openFocus}
          onSpawnForCard={(task, cardId, seed) => { watch(cardId); onSpawnForCard(task, cardId, seed); }}
          onClose={() => showCard(null)}
        />
      )}
    </section>
  );
}

function ColumnView({
  board, agents, mutate, column, index, rows, autoFocusName, onNamed, onOpenCard, onKeyMovedAcross, unreadOn, archived, filter, newCardRepo,
}: {
  board: Board; agents: AgentStatus[]; mutate: Mutate; column: Column; index: number;
  rows: number; autoFocusName: boolean;
  onNamed: () => void; onOpenCard: (id: string, focus?: CardFocus) => void;
  /** a keyboard move just sent this card to another column: refocus it there */
  onKeyMovedAcross: (cardId: string, toColumnId: string) => void;
  /** unread comments on a card — computed by TheLine, which owns the read marks */
  unreadOn: (card: Card) => number;
  archived: number;
  /** THE LINE's repo filter: which cards to show, and the repo a card added here carries */
  filter: RepoFilter; newCardRepo: { repo: string; repoPath?: string } | null;
}) {
  const [dragOver, setDragOver] = useState(false);
  // Which slot a dropped card would take in this column: 0 = above the first
  // card, cards.length = below the last. Null while nothing is hovering, which
  // also means "append" for a drop on the column's empty space.
  const [dropAt, setDropAt] = useState<number | null>(null);
  const all = board.cards.filter((c) => c.columnId === column.id);
  const cards = filterCards(all, filter);
  const filtered = filter.kind !== "all";
  const listRef = useRef<HTMLDivElement>(null);
  useStackCap(listRef, rows, cards.length);

  function clearDrag() { setDragOver(false); setDropAt(null); }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const at = dropAt;
    clearDrag();
    const cardId = e.dataTransfer.getData(CARD_MIME);
    if (cardId) {
      // A drop straight onto the column (not onto a card) appends, as before.
      // Filtered, the slot is among the visible cards; place it by those.
      const to = at === null ? undefined : filtered ? dropIndex(all, cards, at, cardId) : at;
      mutate((b) => moveCard(b, cardId, column.id, to), () => moveCardAction(cardId, column.id, to));
      return;
    }
    const colId = e.dataTransfer.getData(COL_MIME);
    if (colId && colId !== column.id) {
      mutate((b) => reorderColumn(b, colId, index), () => reorderColumnAction(colId, index));
    }
  }

  // Move a card with the keyboard. Drag-and-drop is mouse-only, so without this
  // there is no way to reorder or re-stage a card without a pointer.
  function moveByKey(cardId: string, dir: "left" | "right" | "up" | "down") {
    const t = filtered ? visibleMoveTarget(board, cardId, dir, filter) : cardMoveTarget(board, cardId, dir);
    if (!t) return;
    if (t.toColumnId !== column.id) onKeyMovedAcross(cardId, t.toColumnId);
    mutate(
      (b) => moveCard(b, cardId, t.toColumnId, t.toIndex),
      () => moveCardAction(cardId, t.toColumnId, t.toIndex),
    );
  }

  function onDelete() {
    // The server replaces an empty board with the default one, which then echoes
    // back over SSE — so deleting the last column would silently resurrect the
    // stock columns. Refuse it and say why rather than surprise the user.
    if (board.columns.length <= 1) {
      toast("Keep at least one column — an empty board resets to the default.");
      return;
    }
    // Same bargain as a card: do it, then offer it back. restoreColumn returns
    // the column to its index with the cards that went down with it.
    const doomed = board.cards.filter((c) => c.columnId === column.id);
    const label = column.name || "this column";
    const n = doomed.length;
    mutate((b) => deleteColumn(b, column.id), () => deleteColumnAction(column.id));
    toast(
      n ? `Deleted "${label}" and its ${n} card${n > 1 ? "s" : ""}` : `Deleted "${label}"`,
      {
        label: "UNDO",
        run: () => mutate(
          (b) => restoreColumn(b, column, index, doomed),
          () => restoreColumnAction(column, index, doomed),
        ),
      },
    );
  }

  return (
    <div
      className={`col${dragOver ? " dragover" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={clearDrag}
      onDrop={onDrop}
    >
      <div className="col-head">
        <span
          className="grip pix"
          title="Drag to reorder this column"
          draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData(COL_MIME, column.id); }}
        >⠿</span>
        <InlineText
          className="col-name pix"
          value={column.name}
          placeholder="Name…"
          autoFocus={autoFocusName}
          onCommit={(v) => {
            mutate((b) => renameColumn(b, column.id, v), () => renameColumnAction(column.id, v));
            onNamed();
          }}
        />
        {/* What this column MEANS to an agent's protocol: where new work waits,
            where it is worked, where it lands for review, where it is finished.
            The task footer keys off these, not the column order, so a Triage
            or Merged column can sit anywhere without confusing anyone. */}
        <select
          className="col-stage"
          value={column.stage ?? ""}
          title="Stage: what this column means to an agent (todo, doing, review, done)"
          aria-label={`Stage of column "${column.name || "Untitled"}"`}
          onChange={(e) => {
            const v = e.target.value;
            const stage = (STAGES as readonly string[]).includes(v) ? (v as Stage) : null;
            mutate((b) => setColumnStage(b, column.id, stage), () => setColumnStageAction(column.id, stage));
          }}
        >
          <option value="">-</option>
          {STAGES.map((st) => <option key={st} value={st}>{st.toUpperCase()}</option>)}
        </select>
        <button
          className="col-del"
          title="Delete column"
          aria-label={`Delete column "${column.name || "Untitled"}"`}
          onClick={onDelete}
        >✕</button>
      </div>
      {filtered && (
        <p className="col-count" title={`${cards.length} of ${all.length} cards in this column match the repo filter`}>
          {cards.length} of {all.length} shown
        </p>
      )}

      {mergedColumn(board)?.id === column.id && (
        <ArchiveBar columnId={column.id} cardCount={all.length} archived={archived} />
      )}

      <InstructionField
        value={column.instruction}
        onCommit={(v) => mutate((b) => setInstruction(b, column.id, v), () => setInstructionAction(column.id, v))}
      />

      <div className="cards" ref={listRef} onDragOver={edgeScroll}>
        {cards.map((card, i) => (
          <CardView
            key={card.id}
            agents={agents}
            mutate={mutate}
            card={card}
            index={i}
            dropBefore={dropAt === i}
            dropAfterLast={dropAt === cards.length && i === cards.length - 1}
            // Top half of a card means "above it", bottom half "below it" — the
            // insertion line follows the pointer instead of always appending.
            onDragOverCard={(before) => setDropAt(before ? i : i + 1)}
            onMoveByKey={(dir) => moveByKey(card.id, dir)}
            onOpen={() => onOpenCard(card.id)}
            unread={unreadOn(card)}
            mergeWait={mergeWaitFlag(board, card.id)}
            mergeNext={mergeNextFlag(board, card.id)}
          />
        ))}
      </div>

      <AddCard
        mutate={mutate} columnId={column.id} columnName={column.name} repo={newCardRepo}
        onCreated={(id) => onOpenCard(id, { kind: "new" })}
      />
    </div>
  );
}

/** The face's "wait for that card first" flag: the overlapping, unmerged cards
 *  this one has to let merge before it (see mergeBlockers), so an agent sees
 *  its place in line without opening the card or pressing MERGE. Named by the
 *  first card's title, since that is what the board shows; the ids stay in the
 *  tooltip. Null when nothing is ahead of it. */
export function mergeWaitFlag(board: Board, cardId: string): { label: string; title: string } | null {
  const ahead = mergeBlockers(board, cardId);
  if (!ahead.length) return null;
  const first = board.cards.find((k) => k.id === ahead[0]!.cardId)?.title.trim() || ahead[0]!.cardId;
  const more = ahead.length > 1 ? ` +${ahead.length - 1}` : "";
  return { label: `⏳ after "${first}"${more}`, title: `Waiting to merge: ${mergeBlockReason(board, cardId)}` };
}

/** The other side of mergeWaitFlag: on the card at the FRONT of a merge line
 *  (nothing ahead of it, something behind it), say so and how many wait, so a
 *  person can see which card to merge first without opening each one. The
 *  waiting cards' titles go in the tooltip. Null for a card that waits itself
 *  or that nobody is waiting on. */
export function mergeNextFlag(board: Board, cardId: string): { label: string; title: string } | null {
  if (mergeBlockers(board, cardId).length) return null;
  const behind = board.cards.filter((k) => mergeBlockers(board, k.id).some((c) => c.cardId === cardId));
  if (!behind.length) return null;
  const names = behind.map((k) => `"${k.title.trim() || k.id}"`).join(", ");
  return { label: `next to merge · ${behind.length} waiting`, title: `Merge this first. Waiting behind it: ${names}` };
}

/** The face's repo chip: which project this card is for, so a board mixing
 *  several repos reads at a glance. Null for a card nobody has labelled — it
 *  shows nothing rather than a placeholder that would just be noise. */
export function repoChip(card: Card): { label: string; title: string } | null {
  if (!card.repo) return null;
  return { label: card.repo, title: `Repo: ${card.repo}${card.repoPath ? ` (${card.repoPath})` : ""}` };
}

const PEEK = 10; // px of the next card left showing, so the cut reads as scrollable

// Cap a column's card stack at `rows` cards and let the rest scroll. The cut is
// measured from the real card faces (they vary in height) and re-measured when
// one of them changes size — a title rewrapping, the column narrowing, a meta
// row appearing. `max-height` is set on the element rather than through React so
// nothing re-renders on a resize; `data-capped` is what the stylesheet hangs the
// scrolling off, so an uncapped column looks exactly as it did before.
function useStackCap(ref: RefObject<HTMLDivElement | null>, rows: number, count: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = () => {
      const kids = Array.from(el.children) as HTMLElement[];
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.rowGap) || 0;
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const max = stackMaxHeight(
        kids.map((k) => k.getBoundingClientRect().height), rows, gap, pad, PEEK,
      );
      el.style.maxHeight = max == null ? "" : `${max}px`;
      if (max == null) delete el.dataset.capped;
      else el.dataset.capped = "1";
    };

    apply();
    if (typeof ResizeObserver === "undefined") return;
    // Observing the cards, not the list: the list's own height is what we're
    // setting, so watching it would be a loop.
    const ro = new ResizeObserver(apply);
    for (const k of Array.from(el.children)) ro.observe(k);
    return () => ro.disconnect();
  }, [ref, rows, count]);
}

// A capped stack scrolls, and HTML drag-and-drop won't scroll it for you: a card
// dragged to the bottom edge would have nowhere to go. Nudge the list while the
// pointer sits in the last/first few pixels of it.
const EDGE = 26;
const NUDGE = 14;
function edgeScroll(e: DragEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  if (el.scrollHeight <= el.clientHeight) return;
  const r = el.getBoundingClientRect();
  if (e.clientY > r.bottom - EDGE) el.scrollTop += NUDGE;
  else if (e.clientY < r.top + EDGE) el.scrollTop -= NUDGE;
}

// A card face: click anywhere to open the detail modal. Kept deliberately
// sparse — just the title and a footer with the staffing (its agent's sprite
// avatar, initials when the session has ended, or an UNASSIGNED chip when nobody
// is on it) and a comment count. Detail lives in the modal.
function CardView({
  agents, mutate, card, index, dropBefore, dropAfterLast, onDragOverCard, onMoveByKey, onOpen, unread, mergeWait, mergeNext,
}: {
  agents: AgentStatus[]; mutate: Mutate; card: Card; index: number;
  dropBefore: boolean; dropAfterLast: boolean;
  onDragOverCard: (before: boolean) => void;
  onMoveByKey: (dir: "left" | "right" | "up" | "down") => void;
  onOpen: () => void;
  /** comments on this card you haven't read — 0 when there's nothing new */
  unread: number;
  /** the card(s) that must merge before this one, when any (mergeWaitFlag) */
  mergeWait: { label: string; title: string } | null;
  /** the cards waiting behind this one, when it is at the front (mergeNextFlag) */
  mergeNext: { label: string; title: string } | null;
}) {
  const commentCount = card.comments?.length ?? 0;
  // The live session behind the assignee, if any — gives us its sprite. A card
  // assigned to a session that has since ended falls back to initials.
  const assignedAgent = findLiveAssignee(agents, card.assignee);
  // The sprite bobs on "working", and on a card face that bob is the ONLY thing
  // saying the agent is busy — so it has to be honest. A status file frozen
  // mid-turn (killed session, crashed window, a Stop that never came back) still
  // says "working" for the five minutes it takes to age off the board; ask
  // liveness whether anything has refreshed it lately instead of trusting it.
  const avatarState = assignedAgent ? displayState(assignedAgent, Date.now()) : "idle";
  const repo = repoChip(card);

  // Deleting takes the card's whole comment thread with it, so it has to be
  // recoverable. Rather than a blocking confirm() in front of every delete
  // (which people learn to dismiss), the delete happens and the toast offers it
  // back — restoreCard puts the SAME card, comments and all, at the position it
  // held. Both halves go through mutate, so they apply to the latest board.
  function onDelete() {
    const snapshot = card;
    mutate((b) => deleteCard(b, card.id), () => deleteCardAction(card.id));
    toast(`Deleted "${card.title || "Untitled"}"`, {
      label: "UNDO",
      run: () => mutate(
        (b) => restoreCard(b, snapshot, index),
        () => restoreCardAction(snapshot, index),
      ),
    });
  }

  // The card is a plain container: a real <button> for "open" and the delete
  // button beside it, never one inside the other. A div role="button" wrapping
  // the ✕ swallowed Enter on the ✕ (its keydown bubbled up and opened the card)
  // and read to a screen reader as one long name ending in "Delete card". The
  // container keeps the mouse click (anywhere on the card opens it) and drag.
  return (
    <div
      className={`card${card.kind === "scrum" ? " card-scrum" : ""}${dropBefore ? " drop-before" : ""}${dropAfterLast ? " drop-after" : ""}${unread ? " has-unread" : ""}`}
      data-card-id={card.id}
      draggable
      title={unread
        ? `${unread} unread comment${unread > 1 ? "s" : ""} · Enter opens · Alt+arrows move it`
        : "Enter opens · Alt+arrows move it"}
      onClick={onOpen}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDragOverCard(e.clientY < r.top + r.height / 2);
      }}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData(CARD_MIME, card.id); }}
    >
      {/* Enter and Space are the button's own; its click bubbles to the card's
          onClick, which opens it. */}
      <button
        type="button"
        className="card-main card-open"
        aria-label={cardName(card, assignedAgent ? "live" : card.assignee ? "ended" : "none", unread, commentCount)}
        onKeyDown={(e) => {
          const dir = cardKeyMove(e, e.target === e.currentTarget);
          if (!dir) return;
          e.preventDefault();
          onMoveByKey(dir);
          // The board re-renders around the move, so hold focus on this card to
          // keep a run of moves going instead of dumping focus back to the body.
          // In a capped column the card can land past the fold, and refocusing an
          // element that never lost focus scrolls nothing — so bring it back into
          // view by hand, or the card you're moving disappears under you.
          const el = e.currentTarget;
          requestAnimationFrame(() => { el.focus(); el.scrollIntoView({ block: "nearest" }); });
        }}
      >
        {card.kind === "scrum" && <span className="card-kind">★ SCRUM MASTER</span>}
        <span className="card-title-text">{card.title || "Untitled"}</span>
        <span className="card-meta">
          {/* Staffing always says something. An unstaffed card used to just omit
              the avatar, which reads as "nothing here" — the same as a card whose
              footer is empty for other reasons. A chip makes "nobody is on this"
              a thing you can scan a backlog column for. */}
          {/* The card's number, so people and agents can point at it ("see
              #42"). Quiet: it's for reference, not for scanning. */}
          <span className="card-ref" title={`Card ${cardRef(card)}`}>{cardRef(card)}</span>
          {repo && <span className="card-repo" title={repo.title}>{repo.label}</span>}
          {card.assignee
            ? (assignedAgent
                ? <span className="card-avatar" title={card.assignee.name}>
                    <Sprite sessionId={assignedAgent.sessionId} role={assignedAgent.role} name={assignedAgent.name} state={avatarState} override={assignedAgent.sprite} />
                  </span>
                : <span className="card-assignee" title={`${card.assignee.name} (session ended)`}>{initials(card.assignee.name)}</span>)
            : <span className="card-unassigned" title="No agent assigned yet">Unassigned</span>}
          {card.description && <span className="card-flag" title="Has a description">≡</span>}
          {mergeWait && <span className="card-flag card-flag-wait" title={mergeWait.title}>{mergeWait.label}</span>}
          {mergeNext && <span className="card-flag card-flag-wait card-flag-next" title={mergeNext.title}>{mergeNext.label}</span>}
          {/* Unread turns the count into "N NEW" and colours it, so a thread
              you've already read never looks the same as one that's moved on.
              Not a live region: every unread card on the board would announce
              on each re-render. */}
          {commentCount > 0 && (
            unread
              ? <span className="card-flag card-flag-unread"
                      title={`${unread} unread of ${commentCount} comment${commentCount > 1 ? "s" : ""}`}>
                  💬 {unread} NEW
                </span>
              : <span className="card-flag" title={`${commentCount} comment${commentCount > 1 ? "s" : ""}`}>💬 {commentCount}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        className="card-del"
        title="Delete card"
        aria-label={`Delete card "${card.title || "Untitled"}"`}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >✕</button>
    </div>
  );
}

/** A card's accessible name: its title, then who is on it and what's new —
 *  what the face shows, in words. The chips inside the open button are only
 *  pictures and initials, so the name has to carry them. */
export function cardName(
  card: Pick<Card, "title" | "kind" | "assignee"> & Partial<Pick<Card, "id" | "num">>,
  staffing: "live" | "ended" | "none",
  unread: number,
  commentCount: number,
): string {
  const parts = [card.title || "Untitled"];
  if (card.kind === "scrum") parts.push("scrum master");
  if (card.assignee && staffing !== "none") {
    parts.push(staffing === "ended" ? `${card.assignee.name} (session ended)` : card.assignee.name);
  } else parts.push("unassigned");
  if (unread) parts.push(`${unread} new comment${unread > 1 ? "s" : ""}`);
  else if (commentCount) parts.push(`${commentCount} comment${commentCount > 1 ? "s" : ""}`);
  if (card.id) parts.push(`card ${cardRef({ id: card.id, num: card.num })}`);
  return parts.join(", ");
}

/** Which way a keypress moves a card, or null to leave it alone. Alt+arrows
 *  only (Alt keeps them clear of the browser's own arrow scrolling), and only
 *  when the key was pressed on the card's own open control — a key bubbling up
 *  from anything inside it is that control's business. */
export function cardKeyMove(
  e: { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean },
  onCard: boolean,
): "left" | "right" | "up" | "down" | null {
  if (!onCard || !e.altKey || e.metaKey || e.ctrlKey) return null;
  return KEY_DIR[e.key] ?? null;
}

const KEY_DIR: Record<string, "left" | "right" | "up" | "down" | undefined> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
};

// First letters of the first two words, for the assignee chip (e.g. "Backend
// Dev" -> "BD"). Falls back to the first character.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const letters = parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
  return letters || "?";
}

// Enter makes the card and opens it, ready to fill in, so a new ticket never
// sits there as a bare title. Blur (clicking away) still saves it but leaves
// you where you clicked — that click was about something else.
// Added while the board is filtered to a repo, the card carries that repo, so it
// stays in view and is labelled from the start.
function AddCard({ mutate, columnId, columnName, repo, onCreated }: {
  mutate: Mutate; columnId: string; columnName: string;
  repo: { repo: string; repoPath?: string } | null; onCreated: (cardId: string) => void;
}) {
  const [value, setValue] = useState("");
  function commit(open: boolean) {
    const t = value.trim();
    if (!t) return;
    // The server mints the id; the modal shows once the SSE echo brings the
    // card in, whichever of the two lands first.
    mutate(null, () => { void addCardAction(columnId, t, repo).then((id) => { if (id && open) onCreated(id); }); });
    setValue("");
  }
  return (
    <input
      className="add-card"
      value={value}
      placeholder={repo ? `+ add ${repo.repo} card` : "+ add card"}
      aria-label={`Add card to ${columnName || "Untitled"}${repo ? ` for ${repo.repo}` : ""}`}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") commit(true); }}
      onBlur={() => commit(false)}
    />
  );
}

// A single-line field that shows a live draft while focused and commits on
// blur/Enter (Escape cancels). Editing is driven by local state so a snapshot
// refresh never overwrites what you're typing.
function InlineText({
  value, placeholder, className, autoFocus, onCommit, onEditingChange,
}: {
  value: string; placeholder?: string; className?: string; autoFocus?: boolean;
  onCommit: (v: string) => void; onEditingChange?: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // Escape cancels: it calls blur(), which fires onBlur synchronously with the
  // still-edited `draft` in scope (the queued setDraft(value) hasn't rendered),
  // so committing there would persist the very text the user tried to discard.
  // This flag makes onBlur skip that one commit.
  const cancelling = useRef(false);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  function start() { setEditing(true); onEditingChange?.(true); }
  function stop() { setEditing(false); onEditingChange?.(false); }

  return (
    <input
      ref={ref}
      className={className}
      value={editing ? draft : value}
      placeholder={placeholder}
      onFocus={start}
      onBlur={() => {
        stop();
        if (cancelling.current) { cancelling.current = false; setDraft(value); return; }
        onCommit(draft.trim());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === "Escape") { cancelling.current = true; (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

// The multi-line instruction. Same commit-on-blur discipline as InlineText, but
// Enter inserts a newline (instructions are prose) and whitespace is preserved.
function InstructionField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  return (
    <textarea
      className="col-instr"
      value={editing ? draft : value}
      placeholder="Instruction for an agent working this stage — e.g. Once done, ensure the worktree is clean and committed, then report in the ticket."
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft !== value) onCommit(draft); }}
    />
  );
}
