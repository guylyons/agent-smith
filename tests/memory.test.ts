// tests/memory.test.ts — the team memory graph (src/lib/memory.ts): facts
// agents record, cards read back from the board and archive, keyword search
// with filters, graph neighbours, and the compaction that keeps it lean.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { fixtureDir } from "./fixtures";
import type { Board } from "../src/lib/board";
import type { Archive } from "../src/lib/archive";
import {
  emptyMemory, remember, forget, sanitizeMemory, normalizeLink, cardNodes, memoryView,
  searchMemory, neighbours, compactMemory, summarize, formatResults,
  readMemory, loadMemoryForWrite, writeMemory, memoryFile, MAX_FACTS, COMPACT_AFTER_MS, SUMMARY_MAX,
  record, MAX_LINKS, MAX_TAGS, BY_MAX, BODY_MAX,
} from "../src/lib/memory";

const DAY = 86_400_000;
const NOW = 100 * DAY;

const BOARD: Board = {
  columns: [
    { id: "doing", name: "In Progress", instruction: "", stage: "doing" },
    { id: "merged", name: "Merged", instruction: "" },
  ],
  cards: [
    {
      id: "card_a", title: "Fix merge race", columnId: "merged", repo: "agent-smith",
      description: "Two merges at once corrupt the queue.",
      assignee: { id: "s1", name: "VASQUEZ" }, touches: ["src/lib/merge.ts"],
      comments: [{ id: "c1", author: "VASQUEZ", text: "Done: added a lock around the merge queue.", at: NOW - DAY }],
    },
    { id: "card_b", title: "Board colours", columnId: "doing", repo: "agent-smith", touches: ["src/ui/App.tsx"] },
  ],
};

const ARCHIVE: Archive = {
  cards: [{
    id: "card_old", title: "Old archive work", columnId: "merged", repo: "tubetable", archivedAt: NOW - 90 * DAY,
    description: "A long story. ".repeat(40), comments: [{ id: "c2", author: "RIPLEY", text: "Shipped it.", at: NOW - 90 * DAY }],
  }],
};

// ---- links -----------------------------------------------------------------

test("normalizeLink keeps the known kinds and drops the rest", () => {
  expect(normalizeLink("repo:Agent-Smith")).toBe("repo:agent-smith");
  expect(normalizeLink("repo:~/github/agent-smith/")).toBe("repo:agent-smith");
  expect(normalizeLink("file:./src/lib/board.ts")).toBe("file:src/lib/board.ts");
  expect(normalizeLink("person:vasquez")).toBe("person:VASQUEZ");
  expect(normalizeLink("card_1234")).toBe("card:card_1234");
  expect(normalizeLink("card:card_1234")).toBe("card:card_1234");
  expect(normalizeLink("mem_abcd1234")).toBe("mem_abcd1234");
  expect(normalizeLink("http://evil")).toBeNull();
  expect(normalizeLink("repo:")).toBeNull();
  expect(normalizeLink(42 as unknown as string)).toBeNull();
});

// ---- remember / forget -----------------------------------------------------

test("remember adds a fact with an id, clean links and the author", () => {
  const { memory, node } = remember(emptyMemory(), {
    kind: "decision", title: "Keyword search only", body: "No embeddings: no new deps.",
    tags: ["Search", "search", " "], links: ["repo:agent-smith", "junk", "card_a"], by: "DALLAS",
  }, NOW);
  expect(node.id).toMatch(/^mem_[0-9a-f]{8}$/);
  expect(memory.nodes).toHaveLength(1);
  expect(node).toMatchObject({ kind: "decision", title: "Keyword search only", by: "DALLAS", at: NOW, updatedAt: NOW });
  expect(node.tags).toEqual(["search"]);
  expect(node.links).toEqual(["repo:agent-smith", "card:card_a"]);
});

test("remembering the same kind and title again updates the one node", () => {
  let m = remember(emptyMemory(), { kind: "gotcha", title: "Bun watch leaks", links: ["file:src/server.ts"] }, NOW - DAY).memory;
  const again = remember(m, { kind: "gotcha", title: "  bun WATCH leaks ", body: "Close the watcher.", links: ["repo:agent-smith"] }, NOW);
  expect(again.memory.nodes).toHaveLength(1);
  expect(again.node.id).toBe(m.nodes[0]!.id);
  expect(again.node.body).toBe("Close the watcher.");
  expect(again.node.links).toEqual(["file:src/server.ts", "repo:agent-smith"]);
  expect(again.node.at).toBe(NOW - DAY);
  expect(again.node.updatedAt).toBe(NOW);
});

test("remember refuses a blank title or unknown kind", () => {
  expect(() => remember(emptyMemory(), { kind: "decision", title: "  " }, NOW)).toThrow(/title/);
  expect(() => remember(emptyMemory(), { kind: "wish" as any, title: "x" }, NOW)).toThrow(/kind/);
});

test("forget drops the node and every link to it", () => {
  let m = remember(emptyMemory(), { kind: "note", title: "A" }, NOW).memory;
  const a = m.nodes[0]!.id;
  m = remember(m, { kind: "note", title: "B", links: [a] }, NOW).memory;
  const r = forget(m, a);
  expect(r).not.toBeNull();
  expect(r!.nodes.map((n) => n.title)).toEqual(["B"]);
  expect(r!.nodes[0]!.links).toEqual([]);
  expect(forget(m, "mem_nope0000")).toBeNull();
});

// ---- sanitize --------------------------------------------------------------

test("sanitizeMemory repairs junk instead of failing the read", () => {
  expect(sanitizeMemory(null)).toEqual(emptyMemory());
  expect(sanitizeMemory({ nodes: "x" })).toEqual(emptyMemory());
  const m = sanitizeMemory({ nodes: [
    { id: "mem_00000001", kind: "note", title: "ok", at: 5, links: ["repo:x", 3, "bad"] },
    { id: "mem_00000001", kind: "note", title: "dupe id", at: 5 },
    { id: "../../etc", kind: "note", title: "bad id", at: 5 },
    { id: "mem_00000002", kind: "nope", title: "bad kind", at: 5 },
    { id: "mem_00000003", kind: "note", title: "", at: 5 },
    { id: "mem_00000004", kind: "note", title: "no time" },
  ] });
  expect(m.nodes.map((n) => n.id)).toEqual(["mem_00000001", "mem_00000004"]);
  expect(m.nodes[0]!.links).toEqual(["repo:x"]);
  expect(m.nodes[1]!.at).toBe(0);
});

// ---- cards as nodes --------------------------------------------------------

test("cardNodes turns board and archive cards into linked nodes", () => {
  const nodes = cardNodes(BOARD, ARCHIVE);
  const a = nodes.find((n) => n.id === "card:card_a")!;
  expect(a).toMatchObject({ kind: "card", title: "Fix merge race", at: NOW - DAY });
  expect(a.body).toContain("Two merges at once");
  expect(a.body).toContain("Done: added a lock");
  expect(a.tags).toEqual(["merged"]);
  expect(a.links).toEqual(["repo:agent-smith", "person:VASQUEZ", "file:src/lib/merge.ts"]);
  expect(nodes.find((n) => n.id === "card:card_old")!.tags).toEqual(["merged", "archived"]);
  expect(nodes.map((n) => n.id).sort()).toEqual(["card:card_a", "card:card_b", "card:card_old"]);
});

test("a card's outcome (last comment) survives a long description", () => {
  const long: Board = { ...BOARD, cards: [{ ...BOARD.cards[0]!, description: "word ".repeat(400) }] };
  const a = cardNodes(long, { cards: [] }).find((n) => n.id === "card:card_a")!;
  expect(a.body).toContain("Done: added a lock");
  expect(a.body!.length).toBeLessThanOrEqual(600);
});

test("a card on the board and in the archive shows once, as the board's", () => {
  const dup: Archive = { cards: [{ ...BOARD.cards[0]!, title: "stale", archivedAt: 1 }] };
  const nodes = cardNodes(BOARD, dup);
  expect(nodes.filter((n) => n.id === "card:card_a").map((n) => n.title)).toEqual(["Fix merge race"]);
});

// ---- compaction ------------------------------------------------------------

test("summarize keeps the first sentence, one line, capped", () => {
  expect(summarize("First bit.  Second\nbit.")).toBe("First bit.");
  expect(summarize("no stop at all")).toBe("no stop at all");
  const long = summarize("x".repeat(500));
  expect(long.length).toBe(SUMMARY_MAX);
  expect(long.endsWith("…")).toBe(true);
});

test("compaction shrinks old bodies to a summary and leaves fresh ones", () => {
  let m = remember(emptyMemory(), { kind: "note", title: "old", body: "Kept this. And a lot more detail." }, NOW - COMPACT_AFTER_MS - 1).memory;
  m = remember(m, { kind: "note", title: "new", body: "Fresh. Detail stays." }, NOW).memory;
  const c = compactMemory(m, NOW);
  expect(c.nodes.find((n) => n.title === "old")).toMatchObject({ body: "Kept this.", compact: true });
  expect(c.nodes.find((n) => n.title === "new")).toMatchObject({ body: "Fresh. Detail stays." });
  expect(c.nodes.find((n) => n.title === "new")!.compact).toBeUndefined();
});

test("compaction drops links to facts that are gone", () => {
  const m = sanitizeMemory({ nodes: [{ id: "mem_00000001", kind: "note", title: "x", at: NOW, links: ["mem_deadbeef", "repo:a"] }] });
  expect(compactMemory(m, NOW).nodes[0]!.links).toEqual(["repo:a"]);
});

test("over the cap, compaction evicts old notes before decisions", () => {
  let m = emptyMemory();
  m = remember(m, { kind: "decision", title: "oldest decision" }, 0).memory;
  for (let i = 0; i < MAX_FACTS; i++) m = remember(m, { kind: "note", title: `note ${i}` }, i + 1).memory;
  const c = compactMemory(m, NOW);
  expect(c.nodes).toHaveLength(MAX_FACTS);
  expect(c.nodes.some((n) => n.title === "oldest decision")).toBe(true);
  expect(c.nodes.some((n) => n.title === "note 0")).toBe(false);
});

// A fact compaction evicts on the way in must not be reported as kept: with
// the store full of higher-ranked facts, a new note is the first to go.
function fullOfDecisions() {
  let m = emptyMemory();
  for (let i = 0; i < MAX_FACTS; i++) m = remember(m, { kind: "decision", title: `decision ${i}` }, NOW).memory;
  return m;
}

test("record says dropped when compaction evicts the new fact, and leaves the memory as it was", () => {
  const full = fullOfDecisions();
  const r = record(full, { kind: "note", title: "a late note" }, NOW + 1);
  expect(r.dropped).toBe(true);
  expect(r.memory.nodes.some((n) => n.title === "a late note")).toBe(false);
  expect(r.memory.nodes).toHaveLength(MAX_FACTS);
});

test("record keeps a fact that outranks what it evicts, and compacts", () => {
  let m = remember(emptyMemory(), { kind: "note", title: "old note" }, 1).memory;
  for (let i = 1; i < MAX_FACTS; i++) m = remember(m, { kind: "decision", title: `decision ${i}` }, NOW).memory;
  const r = record(m, { kind: "decision", title: "the new one" }, NOW + 1);
  expect(r.dropped).toBe(false);
  expect(r.memory.nodes.some((n) => n.id === r.node.id)).toBe(true);
  expect(r.memory.nodes.some((n) => n.title === "old note")).toBe(false);
  expect(r.memory.nodes).toHaveLength(MAX_FACTS);
});

// ---- caps per fact -----------------------------------------------------------

const manyLinks = (n: number) => Array.from({ length: n }, (_, i) => `file:src/f${i}.ts`);
const manyTags = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

test("remember caps links and tags per fact, even across same-title updates", () => {
  let m = remember(emptyMemory(), { kind: "note", title: "busy", links: manyLinks(MAX_LINKS + 50), tags: manyTags(MAX_TAGS + 5) }, NOW).memory;
  expect(m.nodes[0]!.links).toHaveLength(MAX_LINKS);
  expect(m.nodes[0]!.tags).toHaveLength(MAX_TAGS);
  // an update merges old links in; the total stays capped and the new link is kept
  m = remember(m, { kind: "note", title: "busy", links: ["repo:fresh"], tags: ["fresh"] }, NOW + 1).memory;
  expect(m.nodes[0]!.links).toHaveLength(MAX_LINKS);
  expect(m.nodes[0]!.links).toContain("repo:fresh");
  expect(m.nodes[0]!.tags).toHaveLength(MAX_TAGS);
  expect(m.nodes[0]!.tags).toContain("fresh");
});

test("remember caps by and body length", () => {
  const { node } = remember(emptyMemory(), { kind: "note", title: "t", body: "x".repeat(BODY_MAX + 10), by: "Y".repeat(BY_MAX + 10) }, NOW);
  expect(node.body).toHaveLength(BODY_MAX);
  expect(node.by).toHaveLength(BY_MAX);
});

test("sanitizeMemory caps links, tags, by and body in a hand-edited file", () => {
  const m = sanitizeMemory({ nodes: [{
    id: "mem_00000001", kind: "note", title: "big", at: NOW,
    links: manyLinks(50_000), tags: manyTags(1000), by: "Z".repeat(10_000), body: "b".repeat(BODY_MAX * 3),
  }] });
  const n = m.nodes[0]!;
  expect(n.links).toHaveLength(MAX_LINKS);
  expect(n.tags).toHaveLength(MAX_TAGS);
  expect(n.by).toHaveLength(BY_MAX);
  expect(n.body).toHaveLength(BODY_MAX);
});

test("the view compacts old cards too, without touching the stored memory", () => {
  const view = memoryView(emptyMemory(), BOARD, ARCHIVE, NOW);
  const old = view.find((n) => n.id === "card:card_old")!;
  expect(old.compact).toBe(true);
  expect(old.body!.length).toBeLessThanOrEqual(SUMMARY_MAX);
});

// ---- search ----------------------------------------------------------------

function sample() {
  let m = remember(emptyMemory(), {
    kind: "decision", title: "Lock the merge queue", body: "One merge at a time.",
    links: ["repo:agent-smith", "file:src/lib/merge.ts", "card_a"], by: "DALLAS",
  }, NOW - 2 * DAY).memory;
  m = remember(m, { kind: "gotcha", title: "Ghostty needs focus", body: "Merge keys ignored without it.", tags: ["ui"], links: ["repo:agent-smith"] }, NOW - 3 * DAY).memory;
  m = remember(m, { kind: "note", title: "Tubetable uses pnpm", links: ["repo:tubetable"] }, NOW).memory;
  return memoryView(m, BOARD, ARCHIVE, NOW);
}

test("search ranks a title hit above a body hit, every term required", () => {
  const r = searchMemory(sample(), "merge").map((x) => x.title);
  expect(r.slice(0, 2).sort()).toEqual(["Fix merge race", "Lock the merge queue"]);
  expect(r).toContain("Ghostty needs focus"); // body-only hit, ranked after
  expect(searchMemory(sample(), "merge pnpm")).toEqual([]);
});

test("search filters by kind, repo, file prefix, person, tag and card", () => {
  const titles = (q: string) => searchMemory(sample(), q).map((x) => x.title).sort();
  expect(titles("kind:gotcha")).toEqual(["Ghostty needs focus"]);
  expect(titles("repo:tubetable")).toEqual(["Old archive work", "Tubetable uses pnpm"]);
  expect(titles("file:src/lib")).toEqual(["Fix merge race", "Lock the merge queue"]);
  expect(titles("person:vasquez")).toEqual(["Fix merge race"]);
  expect(titles("tag:ui")).toEqual(["Ghostty needs focus"]);
  expect(titles("card:card_a")).toEqual(["Fix merge race", "Lock the merge queue"]);
  expect(titles("kind:decision,gotcha")).toEqual(["Ghostty needs focus", "Lock the merge queue"]);
});

test("since: keeps only nodes touched in the last N days", () => {
  const titles = searchMemory(sample(), "since:2d", { now: NOW }).map((x) => x.title).sort();
  expect(titles).toEqual(["Fix merge race", "Lock the merge queue", "Tubetable uses pnpm"]);
});

test("an empty query lists newest first; limit caps it", () => {
  const r = searchMemory(sample(), "", { limit: 2 });
  expect(r).toHaveLength(2);
  expect(r[0]!.title).toBe("Tubetable uses pnpm");
});

test("near: finds the graph neighbours of a node", () => {
  const view = sample();
  const lock = view.find((n) => n.title === "Lock the merge queue")!;
  const titles = searchMemory(view, `near:${lock.id}`).map((x) => x.title);
  expect(titles).toContain("Fix merge race"); // linked card, shares a file
  expect(titles).not.toContain("Lock the merge queue");
  expect(titles).not.toContain("Tubetable uses pnpm");
  expect(neighbours(view, "card:card_a").map((n) => n.title)).toContain("Lock the merge queue");
});

test("formatResults is a compact text digest with ids and links", () => {
  const out = formatResults(searchMemory(sample(), "kind:decision"));
  expect(out).toContain("decision");
  expect(out).toContain("Lock the merge queue");
  expect(out).toContain("file:src/lib/merge.ts");
  expect(out).toMatch(/mem_[0-9a-f]{8}/);
  expect(formatResults([])).toMatch(/nothing/i);
});

// ---- disk ------------------------------------------------------------------

const dir = fixtureDir("memory");

test("read and write round-trip; a missing file is empty", () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  expect(readMemory(dir)).toEqual(emptyMemory());
  expect(loadMemoryForWrite(dir)).toEqual(emptyMemory());
  const m = remember(emptyMemory(), { kind: "note", title: "hi" }, NOW).memory;
  writeMemory(dir, m);
  expect(readMemory(dir)).toEqual(m);
  expect(JSON.parse(readFileSync(memoryFile(dir), "utf8")).version).toBe(1);
});

test("a corrupt file reads empty but refuses a write-load", () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(memoryFile(dir), "{not json");
  expect(readMemory(dir)).toEqual(emptyMemory());
  expect(loadMemoryForWrite(dir)).toBeNull();
});
