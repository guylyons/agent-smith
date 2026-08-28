import { test, expect } from "bun:test";
import { fuzzyScore, buildSearchItems, searchItems, type SearchItem } from "../src/lib/search";
import { defaultBoard, addCard, setCardDescription, addComment } from "../src/lib/board";
import type { Snapshot } from "../src/lib/snapshot";
import type { AgentStatus } from "../src/schema";

const A = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "A", role: "r", ticket: null, state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 1000, ...o,
});

// ---- fuzzyScore ----------------------------------------------------------

test("fuzzyScore matches a contiguous substring", () => {
  expect(fuzzyScore("cat", "category")).not.toBeNull();
});

test("fuzzyScore matches a non-contiguous subsequence", () => {
  expect(fuzzyScore("ctg", "category")).not.toBeNull();
});

test("fuzzyScore returns null when the query is not a subsequence", () => {
  expect(fuzzyScore("xyz", "category")).toBeNull();
  expect(fuzzyScore("tac", "cat")).toBeNull(); // order matters
});

test("fuzzyScore is case-insensitive", () => {
  expect(fuzzyScore("CAT", "category")).not.toBeNull();
  expect(fuzzyScore("cat", "CATEGORY")).not.toBeNull();
});

test("fuzzyScore rewards a contiguous run over a spread-out one", () => {
  const contiguous = fuzzyScore("abc", "abcxxxx")!;
  const spread = fuzzyScore("abc", "axbxcxx")!;
  expect(contiguous).toBeGreaterThan(spread);
});

test("fuzzyScore rewards a word-boundary start over a mid-word one", () => {
  const wordStart = fuzzyScore("cat", "the cat sat")!;
  const midWord = fuzzyScore("cat", "scattered")!;
  expect(wordStart).toBeGreaterThan(midWord);
});

test("fuzzyScore on an empty query is null (nothing to rank on)", () => {
  expect(fuzzyScore("", "anything")).toBeNull();
});

// ---- buildSearchItems ----------------------------------------------------

function snapWith(board = defaultBoard(), agents: AgentStatus[] = []): Snapshot {
  return { agents, board };
}

test("buildSearchItems yields one card item per card, keyed by card id", () => {
  let board = addCard(defaultBoard(), "backlog", "Fix the accordion width");
  const cardId = board.cards[0]!.id;
  const items = buildSearchItems(snapWith(board));
  const card = items.find((i) => i.kind === "card");
  expect(card).toBeDefined();
  expect(card!.id).toBe(cardId);
  expect(card!.title).toBe("Fix the accordion width");
});

test("card haystack includes description, comments, and column name", () => {
  let board = addCard(defaultBoard(), "backlog", "Ticket");
  const cardId = board.cards[0]!.id;
  board = setCardDescription(board, cardId, "make it full width again");
  board = addComment(board, cardId, "ANVIL", "reproduced on Firefox");
  const item = buildSearchItems(snapWith(board)).find((i) => i.id === cardId)!;
  expect(item.hay).toContain("full width");
  expect(item.hay).toContain("firefox"); // lowercased
  expect(item.hay).toContain("backlog"); // column name
});

test("buildSearchItems yields one agent item per agent, keyed by session id", () => {
  const items = buildSearchItems(snapWith(defaultBoard(), [A({ sessionId: "sess-1", name: "SABLE", role: "Backend Dev", ticket: "MHO-96" })]));
  const agent = items.find((i) => i.kind === "agent");
  expect(agent).toBeDefined();
  expect(agent!.id).toBe("sess-1");
  expect(agent!.title).toBe("SABLE");
  expect(agent!.hay).toContain("backend dev");
  expect(agent!.hay).toContain("mho-96");
});

// ---- searchItems ---------------------------------------------------------

const items: SearchItem[] = [
  { kind: "card", id: "c1", title: "Quick find command palette", hay: "quick find command palette backlog" },
  { kind: "card", id: "c2", title: "Usage meter", hay: "usage meter the header shows a quick token count review" },
  { kind: "agent", id: "a1", title: "ANVIL", subtitle: "Backend Dev", hay: "anvil backend dev" },
];

test("searchItems returns only matching items", () => {
  const r = searchItems(items, "palette");
  expect(r.map((i) => i.id)).toEqual(["c1"]);
});

test("searchItems returns nothing for a non-match", () => {
  expect(searchItems(items, "zzzznope")).toEqual([]);
});

test("searchItems ranks a title match above a body-only match", () => {
  // "quick" is in c1's title and in c2's body only — c1 should come first.
  const r = searchItems(items, "quick");
  expect(r[0]!.id).toBe("c1");
});

test("searchItems on an empty query returns all items (palette default)", () => {
  const r = searchItems(items, "");
  expect(r.length).toBe(items.length);
});

test("searchItems respects the limit", () => {
  const r = searchItems(items, "", 2);
  expect(r.length).toBe(2);
});
