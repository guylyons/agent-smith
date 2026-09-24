import { test, expect } from "bun:test";
import { memoryQuery, newestFirst, memoryDay, cardIdsOf, linkLabel, countNote, MEMORY_LIMIT } from "../src/ui/memoryList";
import { FACT_KINDS as LIB_FACT_KINDS, type MemoryNode } from "../src/lib/memory";
import { FACT_KINDS } from "../src/ui/memoryList";

const node = (over: Partial<MemoryNode>): MemoryNode => ({ id: "mem_00000001", kind: "note", title: "t", at: 0, ...over });

test("the query keeps to facts by default and adds the typed words", () => {
  expect(memoryQuery("", "facts")).toBe("kind:decision,gotcha,note,summary");
  expect(memoryQuery("  flaky   test ", "facts")).toBe("kind:decision,gotcha,note,summary flaky test");
  expect(memoryQuery("port", "gotcha")).toBe("kind:gotcha port");
  expect(memoryQuery("port", "card")).toBe("kind:card port");
  expect(memoryQuery("port", "all")).toBe("port");
  expect(memoryQuery("", "all")).toBe("");
});

test("results sort newest first by last update, then by creation", () => {
  const a = node({ id: "mem_0000000a", at: 100 });
  const b = node({ id: "mem_0000000b", at: 50, updatedAt: 300 });
  const c = node({ id: "mem_0000000c", at: 200 });
  expect(newestFirst([a, b, c]).map((n) => n.id)).toEqual(["mem_0000000b", "mem_0000000c", "mem_0000000a"]);
  // the input is left as it was
  const input = [a, b];
  newestFirst(input);
  expect(input[0]).toBe(a);
});

test("the day is the last update's, and an unknown time says so", () => {
  expect(memoryDay(node({ at: Date.UTC(2026, 8, 1, 12), updatedAt: Date.UTC(2026, 8, 24, 12) }))).toBe("2026-09-24");
  expect(memoryDay(node({ at: 0 }))).toBe("no date");
});

test("card ids come from card: links, and a card node is its own card", () => {
  expect(cardIdsOf(node({ links: ["repo:agent-smith", "card:card_1a2b", "file:src/x.ts", "card:card_1a2b", "card:card_9"] }))).toEqual(["card_1a2b", "card_9"]);
  expect(cardIdsOf(node({ id: "card:card_7", kind: "card", links: ["person:RIPLEY-5"] }))).toEqual(["card_7"]);
  expect(cardIdsOf(node({}))).toEqual([]);
});

test("a card link reads as its number and title when the card is on the board", () => {
  const cards = [{ id: "card_1a2b", num: 42, title: "Fix the thing" }];
  expect(linkLabel("card_1a2b", cards)).toEqual({ text: "#42 Fix the thing", onBoard: true });
  expect(linkLabel("card_gone", cards)).toEqual({ text: "card_gone (not on the board)", onBoard: false });
  expect(linkLabel("card_nonum", [{ id: "card_nonum", title: "" }])).toEqual({ text: "(untitled card)", onBoard: true });
});

test("the count line says when the list is cut at the limit", () => {
  expect(countNote(0)).toBe("Nothing in memory matches.");
  expect(countNote(1)).toBe("1 entry, newest first");
  expect(countNote(7)).toBe("7 entries, newest first");
  expect(countNote(MEMORY_LIMIT)).toBe(`The best ${MEMORY_LIMIT} matches, newest first. Narrow the filter to see others.`);
});

test("the UI's fact kinds match the library's", () => {
  expect([...FACT_KINDS]).toEqual([...LIB_FACT_KINDS]);
});
