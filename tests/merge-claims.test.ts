// tests/merge-claims.test.ts — the merge-time half of the file-claim guard.
// card_d59566f7's claims stop two cards being STAFFED on the same files; this
// orders the ones that got staffed anyway (touches edited later, a forced
// assign) so they land one at a time: a card waits for every overlapping,
// unmerged card AHEAD of it, and a real merge through /action/card-merge tells
// the cards it was holding up that they can go.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import {
  defaultBoard,
  mergeBlockers,
  overlappingClaims,
  mergeBlockReason,
  landMergedCard,
  mergedColumn,
  mergeReleaseNotes,
  type Board,
  type Card,
} from "../src/lib/board";
import { holdForClaims, type MergeState } from "../src/lib/merge";
import { mergeWaitFlag } from "../src/ui/TheLine";

function boardWith(...cards: Partial<Card>[]): Board {
  const base = defaultBoard();
  return {
    ...base,
    cards: cards.map((k, i) => ({
      id: k.id ?? `card_${i + 1}`,
      title: k.title ?? `Card ${i + 1}`,
      columnId: k.columnId ?? "backlog",
      ...k,
    })),
  };
}

const assignee = { id: "11111111-2222-4333-8444-555555555555", name: "VOLT" };
const other = { id: "11111111-2222-4333-8444-666666666666", name: "ANVIL" };

// ---- who waits for whom ----------------------------------------------------

test("a card further along the board is ahead: the one behind it waits", () => {
  const b = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["src/server.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["src/server.ts"] },
  );
  expect(mergeBlockers(b, "card_b").map((c) => c.cardId)).toEqual(["card_a"]);
  expect(mergeBlockers(b, "card_a")).toEqual([]);
});

test("in the same column, the card higher up goes first", () => {
  const b = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["src/lib/*.ts"] },
    { id: "card_b", columnId: "review", assignee: other, touches: ["src/lib/merge.ts"] },
  );
  expect(mergeBlockers(b, "card_a")).toEqual([]);
  expect(mergeBlockers(b, "card_b").map((c) => c.cardId)).toEqual(["card_a"]);
});

test("two overlapping cards never both wait on each other", () => {
  const b = boardWith(
    { id: "card_a", columnId: "in-progress", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
  );
  const waiting = ["card_a", "card_b"].filter((id) => mergeBlockers(b, id).length > 0);
  expect(waiting).toEqual(["card_b"]);
});

test("cards that don't overlap don't wait", () => {
  const b = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["a.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["b.ts"] },
  );
  expect(mergeBlockers(b, "card_b")).toEqual([]);
});

test("a merged (done) card holds nobody up", () => {
  const b = boardWith(
    { id: "card_a", columnId: "done", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
  );
  expect(mergeBlockers(b, "card_b")).toEqual([]);
});

test("a card that isn't staffed has nothing to merge, so it waits on nothing", () => {
  const b = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "backlog", touches: ["x.ts"] },
  );
  expect(mergeBlockers(b, "card_b")).toEqual([]);
});

test("a card with no touches is never held and an unknown card is empty", () => {
  const b = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other },
  );
  expect(mergeBlockers(b, "card_b")).toEqual([]);
  expect(mergeBlockers(b, "card_nope")).toEqual([]);
});

test("mergeBlockReason names the card to merge first, in plain ASCII", () => {
  const b = boardWith(
    { id: "card_a", title: "Claims", columnId: "review", assignee, touches: ["src/server.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["src/server.ts"] },
  );
  const why = mergeBlockReason(b, "card_b")!;
  expect(why).toContain("card_a");
  expect(why).toContain("merge that first");
  expect(why).toContain("src/server.ts");
  expect(/^[\x20-\x7e]*$/.test(why)).toBe(true);
  expect(mergeBlockReason(b, "card_a")).toBeNull();
});

// ---- landing a merged card -------------------------------------------------

test("landMergedCard moves the card into the done-stage column", () => {
  const b = boardWith({ id: "card_a", columnId: "review", assignee, touches: ["x.ts"] });
  expect(landMergedCard(b, "card_a").cards[0]!.columnId).toBe("done");
});

/** The stock board plus stageless columns after Done, e.g. a "Merged". */
function withColumnsAfterDone(b: Board, ...names: string[]): Board {
  return { ...b, columns: [...b.columns, ...names.map((n) => ({ id: `col_${n.toLowerCase()}`, name: n, instruction: "" }))] };
}

test("mergedColumn is the last landed column after Done, where merged cards live", () => {
  expect(mergedColumn(withColumnsAfterDone(defaultBoard(), "Merged"))!.id).toBe("col_merged");
  expect(mergedColumn(withColumnsAfterDone(defaultBoard(), "Merged", "Archived"))!.id).toBe("col_archived");
});

test("mergedColumn falls back to the done-stage column, and to nothing without one", () => {
  expect(mergedColumn(defaultBoard())!.id).toBe("done");
  expect(mergedColumn({ columns: [{ id: "c1", name: "Doing", instruction: "", stage: "doing" }], cards: [] })).toBeUndefined();
});

test("mergedColumn skips a column after Done that isn't a landed one", () => {
  const b = withColumnsAfterDone(defaultBoard(), "Merged");
  const odd = { ...b, columns: [...b.columns, { id: "col_redo", name: "Redo", instruction: "", stage: "todo" as const }] };
  expect(mergedColumn(odd)!.id).toBe("col_merged");
});

test("landMergedCard lands a card in Merged when the board has one", () => {
  const b = withColumnsAfterDone(boardWith({ id: "card_a", columnId: "review", assignee }), "Merged");
  expect(landMergedCard(b, "card_a").cards[0]!.columnId).toBe("col_merged");
});

test("landMergedCard leaves a card already past done where it is", () => {
  const base = boardWith({ id: "card_a", columnId: "merged", assignee });
  const b = { ...base, columns: [...base.columns, { id: "merged", name: "Merged", instruction: "" }] };
  expect(landMergedCard(b, "card_a")).toBe(b);
});

test("landMergedCard is a no-op on a board with no done column", () => {
  const b: Board = {
    columns: [{ id: "c1", name: "Doing", instruction: "", stage: "doing" }],
    cards: [{ id: "card_a", title: "A", columnId: "c1" }],
  };
  expect(landMergedCard(b, "card_a")).toBe(b);
});

// ---- Done before Merged ------------------------------------------------------
// When a landed column (a "Merged") follows Done, Done holds accepted but
// unmerged work: its cards keep their claims and their place in the line.

test("with Merged after Done, a card in Done still holds its claim", () => {
  const b = withColumnsAfterDone(boardWith(
    { id: "card_a", columnId: "done", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "backlog", touches: ["x.ts"] },
  ), "Merged");
  expect(overlappingClaims(b, "card_b").map((c) => c.cardId)).toEqual(["card_a"]);
});

test("with Merged after Done, a card in Done claims even once nobody is assigned", () => {
  const b = withColumnsAfterDone(boardWith(
    { id: "card_a", columnId: "done", touches: ["x.ts"] },
    { id: "card_b", columnId: "backlog", touches: ["x.ts"] },
  ), "Merged");
  expect(overlappingClaims(b, "card_b").map((c) => c.cardId)).toEqual(["card_a"]);
});

test("with Merged after Done, two overlapping cards in Done merge one at a time", () => {
  const b = withColumnsAfterDone(boardWith(
    { id: "card_a", columnId: "done", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "done", assignee: other, touches: ["x.ts"] },
  ), "Merged");
  expect(mergeBlockers(b, "card_a")).toEqual([]);
  expect(mergeBlockers(b, "card_b").map((c) => c.cardId)).toEqual(["card_a"]);
});

test("with Merged after Done, a card in Review waits on one in Done", () => {
  const b = withColumnsAfterDone(boardWith(
    { id: "card_a", columnId: "done", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "review", assignee: other, touches: ["x.ts"] },
  ), "Merged");
  expect(mergeBlockers(b, "card_b").map((c) => c.cardId)).toEqual(["card_a"]);
});

test("with Merged after Done, a card in Merged has landed and holds nobody up", () => {
  const b = withColumnsAfterDone(boardWith(
    { id: "card_a", columnId: "col_merged", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "done", assignee: other, touches: ["x.ts"] },
  ), "Merged");
  expect(mergeBlockers(b, "card_b")).toEqual([]);
});

test("with Merged after Done, landMergedCard moves a card from Done to Merged", () => {
  const b = withColumnsAfterDone(boardWith({ id: "card_a", columnId: "done", assignee, touches: ["x.ts"] }), "Merged");
  expect(landMergedCard(b, "card_a").cards[0]!.columnId).toBe("col_merged");
});

test("with no column after Done, Done has landed: two cards there wait on nothing", () => {
  const b = boardWith(
    { id: "card_a", columnId: "done", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "done", assignee: other, touches: ["x.ts"] },
  );
  expect(mergeBlockers(b, "card_a")).toEqual([]);
  expect(mergeBlockers(b, "card_b")).toEqual([]);
  expect(landMergedCard(b, "card_a")).toBe(b);
});

test("a staged, non-landed column after Done does not make Done wait", () => {
  const base = boardWith(
    { id: "card_a", columnId: "done", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
  );
  const b = { ...base, columns: [...base.columns, { id: "col_redo", name: "Redo", instruction: "", stage: "todo" as const }] };
  expect(mergeBlockers(b, "card_b")).toEqual([]);
});

// ---- telling the waiting cards ---------------------------------------------

test("mergeReleaseNotes tells each card that was waiting on the merged one", () => {
  const before = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
    { id: "card_c", columnId: "in-progress", assignee: other, touches: ["y.ts"] },
  );
  const after = landMergedCard(before, "card_a");
  const notes = mergeReleaseNotes(before, after, "card_a");
  expect(notes.map((n) => n.cardId)).toEqual(["card_b"]);
  expect(notes[0]!.text).toContain("card_a merged");
  expect(notes[0]!.text).toContain("clear to land");
});

test("a card still behind another after the merge is told what it still waits on", () => {
  const before = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_c", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
  );
  const after = landMergedCard(before, "card_a");
  const notes = mergeReleaseNotes(before, after, "card_a");
  const forC = notes.find((n) => n.cardId === "card_c")!;
  expect(forC.text).toContain("card_a merged");
  expect(forC.text).toContain("card_b");
  expect(forC.text).not.toContain("clear to land");
});

test("mergeReleaseNotes is empty when nothing was waiting", () => {
  const before = boardWith({ id: "card_a", columnId: "review", assignee, touches: ["x.ts"] });
  expect(mergeReleaseNotes(before, landMergedCard(before, "card_a"), "card_a")).toEqual([]);
});

// ---- the MERGE key's state -------------------------------------------------

const readyState: MergeState = {
  repo: true, branch: "ag-b", base: "main", ahead: 1, dirty: false, rootBranch: "main", rootDirty: false,
  committed: true, ready: true, blocked: "", merging: false,
};

test("holdForClaims holds a ready key and says which card to merge first", () => {
  const b = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
  );
  const held = holdForClaims(readyState, b, "card_b");
  expect(held).toMatchObject({ committed: true, ready: false, waitingOn: ["card_a"] });
  expect(held.blocked).toContain("merge that first");
  expect(holdForClaims(readyState, b, "card_a")).toEqual({ ...readyState, waitingOn: [] });
});

test("holdForClaims leaves a key with nothing committed alone", () => {
  const b = boardWith(
    { id: "card_a", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
  );
  const none = { ...readyState, committed: false, ready: false, blocked: "nothing committed on ag-b yet" };
  expect(holdForClaims(none, b, "card_b")).toEqual({ ...none, waitingOn: ["card_a"] });
});

// ---- the card face ----------------------------------------------------------

test("mergeWaitFlag puts the blocking card on the face of the one waiting", () => {
  const b = boardWith(
    { id: "card_a", title: "Rework the header", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
  );
  const flag = mergeWaitFlag(b, "card_b")!;
  // Named by title, which is what a person reads on the board; the id stays
  // in the tooltip for anyone matching it against a comment.
  expect(flag.label).toBe('⏳ after "Rework the header"');
  expect(flag.title).toContain("card_a");
  expect(flag.title).toContain("merge that first");
  expect(mergeWaitFlag(b, "card_a")).toBeNull();
});

test("mergeWaitFlag names the first card ahead and counts the rest", () => {
  const b = boardWith(
    { id: "card_a", title: "First", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_c", title: "Second", columnId: "review", assignee, touches: ["x.ts"] },
    { id: "card_b", columnId: "in-progress", assignee: other, touches: ["x.ts"] },
  );
  expect(mergeWaitFlag(b, "card_b")?.label).toMatch(/^⏳ after "(First|Second)" \+1$/);
});

// ---- over HTTP ---------------------------------------------------------------
// Two cards whose `touches` overlap, each with committed work in its own
// worktree of one repo. card_a is ahead (Review); card_b (In Progress) waits.

const dir = fixtureDir("merge-claims-test");
const repoBase = fixtureDir("merge-claims-repo");
let seq = 0;

const SESSION_A = "7c1e2f30-aaaa-4bbb-8ccc-00000000000a";
const SESSION_B = "7c1e2f30-aaaa-4bbb-8ccc-00000000000b";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

function status(sessionId: string, name: string, cwd: string, branch: string) {
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({
    sessionId, name, role: "r", ticket: "#1", state: "working", doing: "x",
    cwd, branch, updatedAt: 9_999_999_999_999,
  }));
}

async function setup() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { quit: async () => ({ ok: true }) });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const merge = (cardId: string) => post("/action/card-merge", { cardId, author: "You" }, { "sec-fetch-site": "same-origin" });
  const board = async () => ((await (await fetch(`${base}/board`)).json()) as any).board;

  const root = join(repoBase, `r${seq++}`);
  mkdirSync(root, { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@t");
  await git(root, "config", "user.name", "t");
  writeFileSync(join(root, "README"), "root\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "root");

  const ids: Record<string, string> = {};
  for (const s of [
    { key: "a", session: SESSION_A, name: "VOLT", branch: "ag-a", file: "a.txt", column: "review" },
    { key: "b", session: SESSION_B, name: "ANVIL", branch: "ag-b", file: "b.txt", column: "in-progress" },
  ]) {
    const wt = join(root, ".wt", s.branch);
    await git(root, "worktree", "add", "-q", "-b", s.branch, wt, "HEAD");
    writeFileSync(join(wt, s.file), `${s.branch}\n`);
    await git(wt, "add", "-A");
    await git(wt, "commit", "-q", "-m", `work on ${s.branch}`);
    status(s.session, s.name, wt, s.branch);
    const { cardId } = (await (await post("/action/card-add", { columnId: s.column, title: s.branch })).json()) as any;
    ids[s.key] = cardId;
  }
  // Staff both, THEN claim the same file: the staffing gate would refuse the
  // second assign otherwise. This is the overlap the merge order is for.
  await post("/action/card-assign", { cardId: ids.a, sessionId: SESSION_A });
  await post("/action/card-assign", { cardId: ids.b, sessionId: SESSION_B });
  await post("/action/card-update", { cardId: ids.a, touches: ["src/server.ts"] });
  await post("/action/card-update", { cardId: ids.b, touches: ["src/server.ts"] });
  return { server, base, post, merge, board, a: ids.a!, b: ids.b!, root };
}

test("GET /merge-state holds the key on a card waiting behind another", async () => {
  const { server, base, a, b } = await setup();
  const waiting = (await (await fetch(`${base}/merge-state?cardId=${b}`)).json()) as any;
  expect(waiting).toMatchObject({ committed: true, ready: false });
  expect(waiting.blocked).toContain(a);
  expect(waiting.blocked).toContain("merge that first");
  expect(waiting.waitingOn).toEqual([a]);

  const first = (await (await fetch(`${base}/merge-state?cardId=${a}`)).json()) as any;
  expect(first).toMatchObject({ committed: true, ready: true, blocked: "" });
  expect(first.waitingOn).toEqual([]);
  server.stop(true);
});

test("card-merge refuses a card that is waiting behind another, and merges nothing", async () => {
  const { server, merge, b, root } = await setup();
  const res = await merge(b);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("merge that first");
  const log = Bun.spawnSync(["git", "-C", root, "log", "--merges", "--pretty=%s", "main"]).stdout.toString();
  expect(log).toBe("");
  server.stop(true);
});

test("a real merge lands the card in done and tells the waiting card it is clear", async () => {
  const { server, base, merge, board, a, b } = await setup();
  expect(await (await merge(a)).json()).toMatchObject({ ok: true, branch: "ag-a" });

  const after = await board();
  expect(after.cards.find((c: any) => c.id === a).columnId).toBe("done");
  const waiting = after.cards.find((c: any) => c.id === b);
  const note = (waiting.comments ?? []).find((c: any) => c.text.includes(`${a} merged`));
  expect(note).toBeDefined();
  expect(note.text).toContain("clear to land");

  // and the key on the waiting card is live now
  const state = (await (await fetch(`${base}/merge-state?cardId=${b}`)).json()) as any;
  expect(state).toMatchObject({ ready: true, waitingOn: [] });
  expect(await (await merge(b)).json()).toMatchObject({ ok: true, branch: "ag-b" });
  server.stop(true);
});

test("card-merge with force: true lands a waiting card anyway (the human's override)", async () => {
  const { server, post, b } = await setup();
  const res = await post("/action/card-merge", { cardId: b, author: "You", force: true }, { "sec-fetch-site": "same-origin" });
  expect(await res.json()).toMatchObject({ ok: true, branch: "ag-b" });
  server.stop(true);
});

test("a real merge lands the card in the board's Merged column when it has one", async () => {
  const { server, post, merge, board, a } = await setup();
  const { columnId } = (await (await post("/action/column-add", { name: "Merged" })).json()) as any;
  expect(columnId).toBeTruthy();
  expect(await (await merge(a)).json()).toMatchObject({ ok: true });
  expect((await board()).cards.find((c: any) => c.id === a).columnId).toBe(columnId);
  server.stop(true);
});

test("dragging the blocking card to done does not post the merged note", async () => {
  const { server, post, board, a, b } = await setup();
  await post("/action/card-move", { cardId: a, toColumnId: "done", author: "You" });
  const waiting = (await board()).cards.find((c: any) => c.id === b);
  expect((waiting.comments ?? []).some((c: any) => c.text.includes("merged"))).toBe(false);
  server.stop(true);
});

test("the waiting card's assignee is notified when the blocking card merges", async () => {
  const { server, post, merge, a } = await setup();
  // Clear anything queued by the setup, so only the merge's note is left.
  await post("/action/inbox-drain", { sessionId: SESSION_B });
  expect(await (await merge(a)).json()).toMatchObject({ ok: true });
  const drained = (await (await post("/action/inbox-drain", { sessionId: SESSION_B })).json()) as any;
  const note = drained.items.find((t: string) => t.includes(`${a} merged`));
  expect(note).toBeDefined();
  expect(note).toContain("clear to land");
  expect(note).toContain("ag-b"); // the waiting card's own title
  server.stop(true);
});
