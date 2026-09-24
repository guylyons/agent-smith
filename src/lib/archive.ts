// The archive: merged cards taken off THE LINE so the board (and every
// snapshot push that carries it) stops growing with each merge. Archived cards
// live whole — comments, assignee, repo — in `.line-archive.json` next to
// `.line.json`, readable through GET /archive and restorable to the Merged
// column, so archiving loses nothing and can be undone.
//
// Two files means two writes. The server writes the file GAINING the card
// first (archive on archive, board on restore), so a process killed between
// them leaves the card in both files, never in neither. visibleArchive and
// restoreArchivedCard treat a card that is also on the board as the board's.
//
// The mutations are PURE, like board.ts; only the last three functions touch
// the disk.
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { isLandedColumn, mergedColumn, restoreCard, sanitizeCard, type Board, type Card } from "./board";

export type ArchivedCard = Card & { archivedAt: number };
export type Archive = { cards: ArchivedCard[] };

const VERSION = 1;

export function emptyArchive(): Archive {
  return { cards: [] };
}

/** When a card last saw activity: its newest comment (a merge always leaves
 *  one). Undefined for a card with no comments. */
function lastActivity(card: Card): number | undefined {
  const ats = (card.comments ?? []).map((c) => c.at);
  return ats.length ? Math.max(...ats) : undefined;
}

/** The cards in `columnId` that may be archived: only a landed column's (see
 *  isLandedColumn), so work still in flight can never leave the board. With
 *  `olderThanMs`, only cards quiet for that long; a card with no known age
 *  counts as old. */
export function archivableIds(board: Board, columnId: string, now: number, olderThanMs?: number): string[] {
  if (!board.columns.some((c) => c.id === columnId) || !isLandedColumn(board, columnId)) return [];
  return board.cards
    .filter((k) => k.columnId === columnId)
    .filter((k) => {
      if (olderThanMs === undefined) return true;
      const at = lastActivity(k);
      return at === undefined || now - at >= olderThanMs;
    })
    .map((k) => k.id);
}

/** Move `ids` from the board into the archive, stamped `now`. An id already
 *  archived is replaced by the board's copy, so the archive never holds two. */
export function archiveCards(board: Board, archive: Archive, ids: string[], now: number): { board: Board; archive: Archive } {
  const want = new Set(ids);
  const moving = board.cards.filter((k) => want.has(k.id));
  const gone = new Set(moving.map((k) => k.id));
  return {
    board: { ...board, cards: board.cards.filter((k) => !gone.has(k.id)) },
    archive: { cards: [...archive.cards.filter((k) => !gone.has(k.id)), ...moving.map((k) => ({ ...k, archivedAt: now }))] },
  };
}

/** Put an archived card back at the top of the column it was archived from,
 *  or of mergedColumn if that column is gone. Null when the id isn't archived
 *  or the board has nowhere to put it. A card that is somehow on the board
 *  already keeps the board's copy; the stale archive entry is just dropped. */
export function restoreArchivedCard(board: Board, archive: Archive, cardId: string): { board: Board; archive: Archive } | null {
  const entry = archive.cards.find((k) => k.id === cardId);
  if (!entry) return null;
  const rest = { cards: archive.cards.filter((k) => k.id !== cardId) };
  if (board.cards.some((k) => k.id === cardId)) return { board, archive: rest };
  const { archivedAt: _, ...card } = entry;
  const columnId = board.columns.some((c) => c.id === card.columnId) ? card.columnId : mergedColumn(board)?.id;
  if (!columnId) return null;
  return { board: restoreCard(board, { ...card, columnId }, 0), archive: rest };
}

/** What GET /archive shows: newest first, minus any card that is on the
 *  board too (a restore cut short between its two writes). */
export function visibleArchive(board: Board, archive: Archive): ArchivedCard[] {
  const live = new Set(board.cards.map((k) => k.id));
  return archive.cards.filter((k) => !live.has(k.id)).sort((a, b) => b.archivedAt - a.archivedAt);
}

/** Repair arbitrary input into an Archive, with the board's own card rules.
 *  Unusable entries and repeated ids are dropped rather than failing the read. */
export function sanitizeArchive(input: unknown): Archive {
  if (!input || typeof input !== "object" || Array.isArray(input)) return emptyArchive();
  const raw = (input as { cards?: unknown }).cards;
  if (!Array.isArray(raw)) return emptyArchive();
  const seen = new Set<string>();
  const cards: ArchivedCard[] = [];
  for (const v of raw) {
    const card = sanitizeCard(v);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    const at = (v as { archivedAt?: unknown }).archivedAt;
    cards.push({ ...card, archivedAt: typeof at === "number" && Number.isFinite(at) ? at : 0 });
  }
  return { cards };
}

export function archiveFile(dir: string): string {
  return join(dir, ".line-archive.json");
}

export function readArchive(dir: string): Archive {
  try {
    return sanitizeArchive(JSON.parse(readFileSync(archiveFile(dir), "utf8")));
  } catch {
    return emptyArchive(); // missing or corrupt
  }
}

/** The archive as a writer must read it: empty when there is no file yet,
 *  but null when the file is there and can't be parsed. readArchive's
 *  forgiving empty would let the next write erase every card in it. */
export function loadArchiveForWrite(dir: string): Archive | null {
  let text: string;
  try {
    text = readFileSync(archiveFile(dir), "utf8");
  } catch (e) {
    return (e as { code?: string }).code === "ENOENT" ? emptyArchive() : null;
  }
  try { return sanitizeArchive(JSON.parse(text)); } catch { return null; }
}

export function writeArchive(dir: string, archive: Archive): void {
  const clean = sanitizeArchive(archive);
  const tmp = archiveFile(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: VERSION, ...clean }));
  renameSync(tmp, archiveFile(dir));
}

/** Give every card that has no number one, once, in the order the cards were
 *  made — the archive's and the board's together, so a number held by an
 *  archived card is never handed out again. Cards carry no creation time, so
 *  the order is a best guess: the first comment's time, else when it was
 *  archived, else where it sits (archive first, as those are the older cards).
 *  A card in both files (a restore cut short) gets one number in both. Returns
 *  the inputs unchanged when every card is numbered already and the counter
 *  is past them all. */
export function numberCards(board: Board, archive: Archive): { board: Board; archive: Archive; changed: boolean } {
  const all: Card[] = [...archive.cards, ...board.cards];
  const nums = new Map<string, number>();
  for (const k of all) if (k.num && !nums.has(k.id)) nums.set(k.id, k.num);
  const born = (k: Card) => k.comments?.[0]?.at ?? (k as Partial<ArchivedCard>).archivedAt ?? Infinity;
  const todo = all.filter((k, i) => !nums.has(k.id) && all.findIndex((x) => x.id === k.id) === i);
  let next = Math.max(board.nextNum ?? 1, 1 + Math.max(0, ...nums.values()));
  // Array.sort is stable, so cards with no known age keep their file order.
  for (const k of todo.sort((a, b) => born(a) - born(b))) nums.set(k.id, next++);
  if (!todo.length && board.nextNum === next) return { board, archive, changed: false };
  const withNum = <T extends Card>(k: T): T => (k.num ? k : { ...k, num: nums.get(k.id)! });
  return {
    board: { ...board, cards: board.cards.map(withNum), nextNum: next },
    archive: { cards: archive.cards.map(withNum) },
    changed: true,
  };
}
