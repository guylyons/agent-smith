// tests/archive.test.ts — the Merged-column archive (src/lib/archive.ts).
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import type { Board, Card } from "../src/lib/board";
import {
  archivableIds, archiveCards, restoreArchivedCard, visibleArchive,
  sanitizeArchive, readArchive, writeArchive, archiveFile, emptyArchive, loadArchiveForWrite,
} from "../src/lib/archive";

const DAY = 86_400_000;
const NOW = 100 * DAY;

// Backlog -> Done -> Merged: Merged is a landed column past Done.
function board(cards: Card[]): Board {
  return {
    columns: [
      { id: "backlog", name: "Backlog", instruction: "", stage: "todo" },
      { id: "done", name: "Done", instruction: "", stage: "done" },
      { id: "merged", name: "Merged", instruction: "" },
    ],
    cards,
  };
}
const card = (id: string, columnId: string, at?: number): Card => ({
  id, title: id.toUpperCase(), columnId,
  ...(at !== undefined ? { comments: [{ id: `c_${id}`, author: "You", text: "Merged x into main.", at }] } : {}),
});

test("only a landed column's cards can be archived", () => {
  const b = board([card("a", "merged"), card("b", "done"), card("c", "backlog")]);
  expect(archivableIds(b, "merged", NOW)).toEqual(["a"]);
  expect(archivableIds(b, "done", NOW)).toEqual([]); // Done awaits merge here
  expect(archivableIds(b, "backlog", NOW)).toEqual([]);
  expect(archivableIds(b, "nope", NOW)).toEqual([]);
});

test("olderThan keeps recently active cards on the board", () => {
  const b = board([card("old", "merged", NOW - 10 * DAY), card("new", "merged", NOW - DAY), card("bare", "merged")]);
  // A card with no comments has no known age: it counts as old.
  expect(archivableIds(b, "merged", NOW, 7 * DAY).sort()).toEqual(["bare", "old"]);
});

test("archiving moves cards off the board with comments intact", () => {
  const b = board([card("a", "merged", 5), card("b", "merged", 6), card("c", "backlog")]);
  const out = archiveCards(b, emptyArchive(), ["a", "b"], NOW);
  expect(out.board.cards.map((k) => k.id)).toEqual(["c"]);
  expect(out.archive.cards.map((k) => k.id)).toEqual(["a", "b"]);
  expect(out.archive.cards[0]!.comments).toEqual(card("a", "merged", 5).comments);
  expect(out.archive.cards[0]!.archivedAt).toBe(NOW);
  // pure
  expect(b.cards.length).toBe(3);
});

test("archiving an id already in the archive replaces it, never duplicates", () => {
  const b = board([card("a", "merged", 9)]);
  const first = { cards: [{ ...card("a", "merged", 1), archivedAt: 1 }] };
  const out = archiveCards(b, first, ["a"], NOW);
  expect(out.archive.cards.length).toBe(1);
  expect(out.archive.cards[0]!.comments![0]!.at).toBe(9);
});

test("restore puts the card back at the top of Merged, comments and all", () => {
  const b = board([card("x", "merged")]);
  const archived = archiveCards(board([card("a", "merged", 5)]), emptyArchive(), ["a"], NOW).archive;
  const out = restoreArchivedCard(b, archived, "a");
  expect(out).not.toBeNull();
  expect(out!.board.cards.map((k) => k.id)).toEqual(["a", "x"]);
  expect(out!.board.cards[0]).toEqual(card("a", "merged", 5)); // no archivedAt left on it
  expect(out!.archive.cards).toEqual([]);
});

test("restore falls back to the merged column when the card's column is gone", () => {
  const archived = { cards: [{ ...card("a", "col_gone"), archivedAt: 1 }] };
  const out = restoreArchivedCard(board([]), archived, "a");
  expect(out!.board.cards[0]!.columnId).toBe("merged");
});

test("restore of an unknown id is null", () => {
  expect(restoreArchivedCard(board([]), emptyArchive(), "zz")).toBeNull();
});

test("restore of a card already on the board just drops the stale archive copy", () => {
  // A crash between the two writes can leave a card in both files.
  const b = board([card("a", "merged", 7)]);
  const archived = { cards: [{ ...card("a", "merged", 1), archivedAt: 1 }] };
  const out = restoreArchivedCard(b, archived, "a")!;
  expect(out.board).toEqual(b);
  expect(out.archive.cards).toEqual([]);
});

test("visibleArchive hides copies of cards still on the board, newest first", () => {
  const b = board([card("a", "merged")]);
  const archive = { cards: [
    { ...card("a", "merged"), archivedAt: 1 },
    { ...card("b", "merged"), archivedAt: 2 },
    { ...card("c", "merged"), archivedAt: 3 },
  ] };
  expect(visibleArchive(b, archive).map((k) => k.id)).toEqual(["c", "b"]);
});

test("sanitizeArchive drops bad entries and duplicate ids", () => {
  const a = sanitizeArchive({ cards: [
    { id: "a", title: "A", columnId: "merged", archivedAt: 5 },
    { id: "a", title: "A2", columnId: "merged", archivedAt: 6 },
    { id: "b", title: "B" }, // no columnId
    "junk",
    { id: "c", title: "C", columnId: "merged" }, // no archivedAt -> 0
  ] });
  expect(a.cards.map((k) => [k.id, k.archivedAt])).toEqual([["a", 5], ["c", 0]]);
  expect(sanitizeArchive(null)).toEqual(emptyArchive());
  expect(sanitizeArchive([1, 2])).toEqual(emptyArchive());
});

test("read/write round-trip next to .line.json; missing or corrupt reads empty", () => {
  const dir = fixtureDir("archive-test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  expect(archiveFile(dir)).toBe(join(dir, ".line-archive.json"));
  expect(readArchive(dir)).toEqual(emptyArchive());
  const a = { cards: [{ ...card("a", "merged", 3), archivedAt: 4 }] };
  writeArchive(dir, a);
  expect(readArchive(dir)).toEqual(a);
  expect(existsSync(archiveFile(dir) + ".tmp")).toBe(false);
  writeFileSync(archiveFile(dir), "{ half");
  expect(readArchive(dir)).toEqual(emptyArchive());
});

test("loadArchiveForWrite refuses a corrupt file instead of reading it as empty", () => {
  // Writing over a file we couldn't read would erase every card in it.
  const dir = fixtureDir("archive-strict");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  expect(loadArchiveForWrite(dir)).toEqual(emptyArchive()); // missing is fine
  writeFileSync(archiveFile(dir), "{ half");
  expect(loadArchiveForWrite(dir)).toBeNull();
});
