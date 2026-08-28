import { test, expect } from "bun:test";
import { fuzzyScore, fuzzyPositions, matchSnippet, buildSearchItems, searchItems, type SearchItem } from "../src/lib/search";
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
  { kind: "card", id: "c1", title: "Quick find command palette", hay: "quick find command palette backlog", body: "" },
  { kind: "card", id: "c2", title: "Usage meter", hay: "usage meter the header shows a quick token count review", body: "The header shows a quick token count review" },
  { kind: "agent", id: "a1", title: "ANVIL", subtitle: "Backend Dev", hay: "anvil backend dev", body: "Backend Dev" },
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

// ---- matchSnippet --------------------------------------------------------

test("matchSnippet excerpts the text around the match", () => {
  const body = "The accordion collapses when the sidebar is narrow.";
  const hit = matchSnippet("sidebar", body)!;
  expect(hit).not.toBeNull();
  expect(hit.snippet).toContain("sidebar");
});

test("matchSnippet marks point at the matched characters in its own snippet", () => {
  // Long enough that the window is clipped at the front, so marks must be
  // rebased past the leading ellipsis rather than reused as body offsets.
  const body = `${"x padding ".repeat(20)}the flaky retry loop`;
  const hit = matchSnippet("flaky", body)!;
  expect(hit.snippet.startsWith("…")).toBe(true);
  expect(hit.marks.map((m) => hit.snippet[m]).join("")).toBe("flaky");
});

test("matchSnippet marks track a non-contiguous fuzzy match", () => {
  const hit = matchSnippet("flk", "the flaky retry loop")!;
  expect(hit.marks.map((m) => hit.snippet[m]).join("")).toBe("flk");
});

test("matchSnippet keeps the whole body when it is short", () => {
  const hit = matchSnippet("retry", "flaky retry")!;
  expect(hit.snippet).toBe("flaky retry");
  expect(hit.snippet).not.toContain("…");
});

test("matchSnippet is null when the query does not match", () => {
  expect(matchSnippet("zzzznope", "flaky retry loop")).toBeNull();
});

test("matchSnippet caps the window on a match spread across a long body", () => {
  const body = `flaky ${"filler ".repeat(80)} loop`;
  const hit = matchSnippet("flakyloop", body)!;
  expect(hit.snippet.length).toBeLessThanOrEqual(130);
});

// ---- fuzzyPositions ------------------------------------------------------

test("fuzzyPositions returns the index of each matched char, in order", () => {
  expect(fuzzyPositions("cat", "category")).toEqual([0, 1, 2]);
  expect(fuzzyPositions("ctg", "category")).toEqual([0, 2, 4]);
  expect(fuzzyPositions("xyz", "category")).toBeNull();
});

// ---- body snippets on results --------------------------------------------

test("buildSearchItems puts a card's description and comments in its body", () => {
  let board = addCard(defaultBoard(), "backlog", "Fix the accordion width");
  const cardId = board.cards[0]!.id;
  board = setCardDescription(board, cardId, "It collapses on a narrow sidebar");
  board = addComment(board, cardId, "SABLE", "reproduced on the flaky retry path");
  const card = buildSearchItems(snapWith(board)).find((i) => i.kind === "card")!;
  expect(card.body).toContain("narrow sidebar");
  expect(card.body).toContain("flaky retry path");
});

test("buildSearchItems flattens newlines out of a body so it fits one line", () => {
  let board = addCard(defaultBoard(), "backlog", "Fix the accordion width");
  board = setCardDescription(board, board.cards[0]!.id, "line one\n\nline two");
  const card = buildSearchItems(snapWith(board)).find((i) => i.kind === "card")!;
  expect(card.body).toBe("line one line two");
});

test("searchItems attaches a snippet to a body-only hit", () => {
  const r = searchItems(items, "token");
  expect(r[0]!.id).toBe("c2");
  expect(r[0]!.snippet).toContain("token");
  expect(r[0]!.marks).toBeDefined();
});

test("searchItems leaves a title hit without a snippet", () => {
  // The matched text is already the row's headline; a snippet would be noise.
  const r = searchItems(items, "palette");
  expect(r[0]!.id).toBe("c1");
  expect(r[0]!.snippet).toBeUndefined();
});
