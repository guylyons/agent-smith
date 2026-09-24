// tests/repo-filter.test.ts — the card repo is typed by hand, so it drifts
// ("~/github/tubetable" vs "tubetable") and the scrum master for a project
// never hears about a card spelled the other way. The repo field now offers the
// known repos and tidies a path into its folder name; THE LINE can show one
// project's cards at a time.
import { test, expect } from "bun:test";
import { addCard, defaultBoard, moveCard, setCardKind, setCardRepo, type Board, type Card } from "../src/lib/board";
import type { AgentStatus } from "../src/schema";
import {
  normaliseRepo, knownRepos, cardInFilter, filterCards, parseRepoFilter, serialiseRepoFilter, filterRepo,
  dropIndex, visibleMoveTarget, repoKey, scrumTarget, newlyHidden,
  type RepoFilter,
} from "../src/ui/repoFilter";
import { scrumHears } from "../src/lib/crew";

function card(repo?: string): Card {
  return { id: `card_${repo ?? "none"}`, title: "t", columnId: "backlog", ...(repo === undefined ? {} : { repo }) };
}

function agent(cwd: string): Pick<AgentStatus, "cwd"> {
  return { cwd };
}

// ---- normaliseRepo ----------------------------------------------------------

test("a plain name is trimmed and kept, with no path", () => {
  expect(normaliseRepo("  agent-smith ", [])).toEqual({ repo: "agent-smith" });
});

test("blank clears", () => {
  expect(normaliseRepo("   ", [])).toEqual({ repo: "" });
});

test("a ~ path becomes its folder name, and takes the known repo's real path", () => {
  const known = [{ name: "tubetable", path: "/Users/guy/github/tubetable" }];
  expect(normaliseRepo("~/github/tubetable", known)).toEqual({ repo: "tubetable", repoPath: "/Users/guy/github/tubetable" });
});

test("a ~ path with no known repo keeps the name and drops the unexpanded path", () => {
  expect(normaliseRepo("~/github/tubetable/", [])).toEqual({ repo: "tubetable" });
});

test("a full path becomes its folder name and keeps the path", () => {
  expect(normaliseRepo(" /Users/guy/github/tubetable/ ", [])).toEqual({ repo: "tubetable", repoPath: "/Users/guy/github/tubetable" });
});

test("a worktree path is the repo it belongs to", () => {
  expect(normaliseRepo("/r/agent-smith/.claude/worktrees/repo-filter", [])).toEqual({ repo: "agent-smith", repoPath: "/r/agent-smith" });
});

test("a typed absolute path is kept as typed, even when a known repo shares its name", () => {
  const known = [{ name: "api", path: "/Users/guy/work/api" }];
  expect(normaliseRepo("/Users/guy/personal/api", known)).toEqual({ repo: "api", repoPath: "/Users/guy/personal/api" });
});

test("a path inside a worktree is the repo it belongs to", () => {
  expect(normaliseRepo("/x/api/.claude/worktrees/foo/src", [])).toEqual({ repo: "api", repoPath: "/x/api" });
  expect(repoKey("/x/api/.claude/worktrees/foo/src")).toBe("api");
});

test("~, ~/ and / name no folder, so there is nothing to save", () => {
  for (const s of ["~", "~/", " ~/ ", "/", "//"]) expect(normaliseRepo(s, [])).toBeNull();
});

test("trailing slashes don't change what is saved", () => {
  expect(normaliseRepo("/a/b//", [])).toEqual({ repo: "b", repoPath: "/a/b" });
});

// ---- knownRepos -------------------------------------------------------------

test("known repos come from scrum cards, card repos and live agents, deduped and sorted", () => {
  let b: Board = defaultBoard();
  b = addCard(b, "backlog", "scrum");
  const scrumId = b.cards[0]!.id;
  b = setCardKind(setCardRepo(b, scrumId, "tubetable", "/g/tubetable"), scrumId, "scrum");
  b = addCard(b, "backlog", "one");
  b = setCardRepo(b, b.cards[1]!.id, "~/github/tubetable");
  b = addCard(b, "backlog", "two");
  b = setCardRepo(b, b.cards[2]!.id, "agent-smith");
  b = addCard(b, "backlog", "no repo");
  const agents = [agent("/g/agent-smith/.claude/worktrees/x"), agent("/g/SuperDash"), agent("")];
  expect(knownRepos(b, agents)).toEqual([
    { name: "agent-smith", path: "/g/agent-smith" },
    { name: "SuperDash", path: "/g/SuperDash" },
    { name: "tubetable", path: "/g/tubetable" },
  ]);
});

test("known repos is empty on an empty board with no agents", () => {
  expect(knownRepos(defaultBoard(), [])).toEqual([]);
});

// ---- the filter -------------------------------------------------------------

test("all shows every card; none only unlabelled ones; a repo only its own", () => {
  const cards = [card("agent-smith"), card("tubetable"), card(), card("  "), card("~/github/tubetable")];
  const ids = (f: RepoFilter) => filterCards(cards, f).map((c) => c.id);
  expect(ids({ kind: "all" })).toHaveLength(5);
  expect(ids({ kind: "none" })).toEqual(["card_none", "card_  "]);
  expect(ids({ kind: "repo", repo: "agent-smith" })).toEqual(["card_agent-smith"]);
  // a card saved before normalising still counts as its folder's repo
  expect(ids({ kind: "repo", repo: "tubetable" })).toEqual(["card_tubetable", "card_~/github/tubetable"]);
});

test("filtering never changes the cards", () => {
  const c = card("tubetable");
  const before = JSON.stringify(c);
  cardInFilter(c, { kind: "repo", repo: "agent-smith" });
  expect(JSON.stringify(c)).toBe(before);
});

test("the filter round-trips through storage, and junk reads as all", () => {
  for (const f of [{ kind: "all" }, { kind: "none" }, { kind: "repo", repo: "tube:table" }] as RepoFilter[]) {
    expect(parseRepoFilter(serialiseRepoFilter(f))).toEqual(f);
  }
  expect(parseRepoFilter("")).toEqual({ kind: "all" });
  expect(parseRepoFilter("garbage")).toEqual({ kind: "all" });
  expect(parseRepoFilter("repo:  ")).toEqual({ kind: "all" });
});

test("filterRepo is the repo a new card should carry", () => {
  const known = [{ name: "agent-smith", path: "/g/agent-smith" }];
  expect(filterRepo({ kind: "all" }, known)).toBeNull();
  expect(filterRepo({ kind: "none" }, known)).toBeNull();
  expect(filterRepo({ kind: "repo", repo: "agent-smith" }, known)).toEqual({ repo: "agent-smith", repoPath: "/g/agent-smith" });
  expect(filterRepo({ kind: "repo", repo: "gone" }, known)).toEqual({ repo: "gone" });
});

test("scrumTarget uses the filtered repo, else the fallback folder", () => {
  const known = [{ name: "agent-smith", path: "/g/agent-smith" }];
  const repo = (r: string): RepoFilter => ({ kind: "repo", repo: r });
  expect(scrumTarget(repo("agent-smith"), known, "/g/Half-Life")).toEqual({ repo: "agent-smith", folder: "/g/agent-smith" });
  expect(scrumTarget(repo("gone"), known, "/g/Half-Life")).toEqual({ repo: "gone", folder: "" });
  expect(scrumTarget({ kind: "all" }, known, "/g/Half-Life")).toEqual({ repo: "Half-Life", folder: "/g/Half-Life" });
  expect(scrumTarget({ kind: "none" }, known, "")).toEqual({ repo: "", folder: "" });
});

// ---- cards leaving the view -----------------------------------------------------

test("newlyHidden names a watched card the filter just started hiding", () => {
  const none: RepoFilter = { kind: "none" };
  const before = [card(), { ...card(), id: "other" }];
  // the server stamps a repo on the card an agent was launched for
  const after = [{ ...card(), repo: "agent-smith" }, { ...card(), id: "other", repo: "agent-smith" }];
  expect(newlyHidden(before, after, ["card_none"], none).map((c) => c.id)).toEqual(["card_none"]);
});

test("newlyHidden counts a new watched card that lands outside the view", () => {
  const AS_: RepoFilter = { kind: "repo", repo: "agent-smith" };
  expect(newlyHidden([], [card("tubetable")], ["card_tubetable"], AS_).map((c) => c.id)).toEqual(["card_tubetable"]);
  expect(newlyHidden([], [card("agent-smith")], ["card_agent-smith"], AS_)).toEqual([]);
});

test("newlyHidden ignores cards already hidden, unwatched, deleted, or an unfiltered view", () => {
  const AS_: RepoFilter = { kind: "repo", repo: "agent-smith" };
  const t = card("tubetable");
  expect(newlyHidden([t], [t], ["card_tubetable"], AS_)).toEqual([]);
  expect(newlyHidden([card("agent-smith")], [{ ...card("agent-smith"), repo: "x" }], [], AS_)).toEqual([]);
  expect(newlyHidden([card("agent-smith")], [], ["card_agent-smith"], AS_)).toEqual([]);
  expect(newlyHidden([card()], [card("x")], ["card_none"], { kind: "all" })).toEqual([]);
});

// ---- scrum routing ----------------------------------------------------------

test("a scrum master hears a card whose repo was saved as a path to its project", () => {
  let b: Board = addCard(defaultBoard(), "backlog", "scrum");
  const scrumId = b.cards[0]!.id;
  b = setCardKind(setCardRepo(b, scrumId, "tubetable"), scrumId, "scrum");
  b = { ...b, cards: b.cards.map((k) => (k.id === scrumId ? { ...k, assignee: { id: "s1", name: "DALLAS" } } : k)) };
  const sm = { sessionId: "s1" };
  expect(scrumHears(b, sm, card("~/github/tubetable"))).toBe(true);
  expect(scrumHears(b, sm, card("agent-smith"))).toBe(false);
});

// ---- moving cards while filtered ------------------------------------------------


function col(...repos: (string | undefined)[]): Board {
  let b = defaultBoard();
  repos.forEach((r, i) => {
    b = addCard(b, "backlog", `c${i}`);
    const id = b.cards[b.cards.length - 1]!.id;
    b = { ...b, cards: b.cards.map((k) => (k.id === id ? { ...k, id: `c${i}`, ...(r ? { repo: r } : {}) } : k)) };
  });
  return b;
}
const order = (b: Board, colId = "backlog") => b.cards.filter((k) => k.columnId === colId).map((k) => k.id);
const AS: RepoFilter = { kind: "repo", repo: "agent-smith" };

test("dropIndex places a card by its visible neighbours", () => {
  // c0 a, c1 t, c2 a, c3 t, c4 a — agent-smith view shows c0 c2 c4
  const b = col("agent-smith", "tubetable", "agent-smith", "tubetable", "agent-smith");
  const column = b.cards;
  const visible = filterCards(column, AS);
  // drop c4 above c2 (visible slot 1)
  expect(order(moveCard(b, "c4", "backlog", dropIndex(column, visible, 1, "c4")))).toEqual(["c0", "c1", "c4", "c2", "c3"]);
  // drop c0 at the end of the visible list: right after c4
  expect(order(moveCard(b, "c0", "backlog", dropIndex(column, visible, 3, "c0")))).toEqual(["c1", "c2", "c3", "c4", "c0"]);
  // an empty visible list appends
  expect(dropIndex([], [], 0, "x")).toBeUndefined();
});

test("keyboard up/down steps over hidden cards", () => {
  const b = col("agent-smith", "tubetable", "agent-smith");
  const down = visibleMoveTarget(b, "c0", "down", AS)!;
  expect(order(moveCard(b, "c0", down.toColumnId, down.toIndex))).toEqual(["c1", "c2", "c0"]);
  const up = visibleMoveTarget(b, "c2", "up", AS)!;
  expect(order(moveCard(b, "c2", up.toColumnId, up.toIndex))).toEqual(["c2", "c0", "c1"]);
  expect(visibleMoveTarget(b, "c0", "up", AS)).toBeNull();
  expect(visibleMoveTarget(b, "c2", "down", AS)).toBeNull();
});

test("keyboard left/right keeps the visible row in the next column", () => {
  let b = col("agent-smith", "agent-smith");
  b = addCard(b, "in-progress", "x");
  b = { ...b, cards: b.cards.map((k) => (k.title === "x" ? { ...k, id: "x", repo: "tubetable" } : k)) };
  const t = visibleMoveTarget(b, "c1", "right", AS)!;
  expect(t.toColumnId).toBe("in-progress");
  // no visible cards there: appended, after the hidden one
  expect(order(moveCard(b, "c1", t.toColumnId, t.toIndex), "in-progress")).toEqual(["x", "c1"]);
});
