// tests/card-repo.test.ts — a card says which repo it belongs to. One board
// holds cards for several projects; the repo label is filled in when an agent is
// spawned for the card (from the main checkout, never the worktree), editable by
// hand, and shown as a chip on the card face. Old cards without one still load.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import {
  defaultBoard, addCard, setCardRepo, repoName, sanitizeCard, sanitizeBoard, readBoard, writeBoard, type Board,
} from "../src/lib/board";
import { mainCheckout } from "../src/lib/worktree";
import { repoChip } from "../src/ui/TheLine";
import { handleMessage, formatBoard, formatCard, type Api, type Ctx } from "../src/lib/mcp";
import { readSnapshot } from "../src/server";

function oneCard(): { board: Board; id: string } {
  const board = addCard(defaultBoard(), "backlog", "Fix it");
  return { board, id: board.cards[0]!.id };
}

// ---- the pure board ops -----------------------------------------------------

test("repoName is the folder's basename, trailing slashes ignored", () => {
  expect(repoName("/Users/guy/github/agent-smith")).toBe("agent-smith");
  expect(repoName("/Users/guy/github/agent-smith/")).toBe("agent-smith");
  expect(repoName("agent-smith")).toBe("agent-smith");
  expect(repoName("")).toBe("");
  expect(repoName("/")).toBe("");
});

test("setCardRepo stores the name and the full path", () => {
  const { board, id } = oneCard();
  const card = setCardRepo(board, id, "agent-smith", "/r/agent-smith").cards[0]!;
  expect(card.repo).toBe("agent-smith");
  expect(card.repoPath).toBe("/r/agent-smith");
});

test("setCardRepo trims, and a blank or null name clears both fields", () => {
  const { board, id } = oneCard();
  const set = setCardRepo(board, id, "  budget.el  ", "/r/budget.el");
  expect(set.cards[0]!.repo).toBe("budget.el");
  for (const clear of [setCardRepo(set, id, "   "), setCardRepo(set, id, null)]) {
    expect("repo" in clear.cards[0]!).toBe(false);
    expect("repoPath" in clear.cards[0]!).toBe(false);
  }
});

test("a hand-set name with no path drops the old path (it no longer matches)", () => {
  const { board, id } = oneCard();
  const set = setCardRepo(board, id, "agent-smith", "/r/agent-smith");
  const renamed = setCardRepo(set, id, "SuperDash").cards[0]!;
  expect(renamed.repo).toBe("SuperDash");
  expect("repoPath" in renamed).toBe(false);
});

test("setCardRepo does not mutate its input", () => {
  const { board, id } = oneCard();
  setCardRepo(board, id, "agent-smith", "/r/agent-smith");
  expect("repo" in board.cards[0]!).toBe(false);
});

test("sanitizeCard keeps a repo and drops a malformed one", () => {
  const base = { id: "card_1", title: "T", columnId: "backlog" };
  expect(sanitizeCard({ ...base, repo: " agent-smith ", repoPath: "/r/agent-smith" }))
    .toEqual({ ...base, repo: "agent-smith", repoPath: "/r/agent-smith" });
  expect(sanitizeCard({ ...base, repo: 42 })).toEqual(base);
  expect(sanitizeCard({ ...base, repo: "  " })).toEqual(base);
  // A path with no name to show is noise; drop it.
  expect(sanitizeCard({ ...base, repoPath: "/r/x" })).toEqual(base);
});

test("an old board with no repo on any card loads unchanged", () => {
  const old = { version: 4, columns: defaultBoard().columns, cards: [{ id: "card_1", title: "Old", columnId: "backlog" }] };
  const b = sanitizeBoard(old);
  expect(b.cards[0]).toEqual({ id: "card_1", title: "Old", columnId: "backlog" });
});

test("repo survives a write and a read", () => {
  const dir = fixtureDir("card-repo-disk");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { board, id } = oneCard();
  writeBoard(dir, setCardRepo(board, id, "agent-smith", "/r/agent-smith"));
  const card = readBoard(dir).cards[0]!;
  expect(card.repo).toBe("agent-smith");
  expect(card.repoPath).toBe("/r/agent-smith");
});

// ---- the card face ----------------------------------------------------------

test("repoChip: no repo, no chip", () => {
  expect(repoChip({ id: "c", title: "t", columnId: "backlog" })).toBeNull();
});

test("repoChip: shows the name, with the full path as its tooltip when known", () => {
  expect(repoChip({ id: "c", title: "t", columnId: "backlog", repo: "agent-smith", repoPath: "/r/agent-smith" }))
    .toEqual({ label: "agent-smith", title: "Repo: agent-smith (/r/agent-smith)" });
  expect(repoChip({ id: "c", title: "t", columnId: "backlog", repo: "SuperDash" }))
    .toEqual({ label: "SuperDash", title: "Repo: SuperDash" });
});

// ---- resolving the main checkout ---------------------------------------------

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/** A real repo with one commit and a linked worktree under .claude/worktrees. */
async function repoWithWorktree(name: string): Promise<{ root: string; wt: string }> {
  const base = fixtureDir(name);
  rmSync(base, { recursive: true, force: true });
  const root = join(base, "my-project");
  mkdirSync(root, { recursive: true });
  await git(root, "init", "-q");
  await git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(root, ".claude", "worktrees", "some-card");
  await git(root, "worktree", "add", "-q", "-b", "some-card", wt);
  return { root: realpathSync(root), wt };
}

test("mainCheckout resolves a linked worktree to the main repo root", async () => {
  const { root, wt } = await repoWithWorktree("card-repo-git");
  expect(await mainCheckout(wt)).toBe(root);
  expect(await mainCheckout(root)).toBe(root);
});

test("mainCheckout of a folder that is not a repo is the folder itself", async () => {
  const dir = fixtureDir("card-repo-nogit");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  expect(await mainCheckout(dir)).toBe(realpathSync(dir));
});

// ---- over HTTP ----------------------------------------------------------------

async function server() {
  const dir = fixtureDir("card-repo-http");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const srv = makeServer(0, {
    // Stands in for Ghostty: launches nowhere, reports success in the same folder.
    spawn: async (cwd) => ({ ok: true, cwd, worktreeCreated: false }),
  });
  const base = `http://localhost:${srv.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const add = async (title: string) =>
    ((await (await post("/action/card-add", { columnId: "backlog", title })).json()) as any).cardId as string;
  const card = (id: string) => readSnapshot(dir, Date.now()).board.cards.find((k) => k.id === id)!;
  return { srv, post, add, card };
}

test("spawning for a card labels it with the main repo, not the worktree", async () => {
  const { root, wt } = await repoWithWorktree("card-repo-spawn");
  const { srv, post, add, card } = await server();
  try {
    const id = await add("Fix the thing");
    const res = await post("/action/spawn", { cwd: wt, text: "do the card", cardId: id });
    expect(((await res.json()) as any).ok).toBe(true);
    expect(card(id).repo).toBe("my-project");
    expect(card(id).repoPath).toBe(root);
  } finally { srv.stop(true); }
});

test("spawning never overwrites a repo someone already set", async () => {
  const { wt } = await repoWithWorktree("card-repo-keep");
  const { srv, post, add, card } = await server();
  try {
    const id = await add("Fix the thing");
    await post("/action/card-update", { cardId: id, repo: "SuperDash" });
    await post("/action/spawn", { cwd: wt, text: "do the card", cardId: id });
    expect(card(id).repo).toBe("SuperDash");
  } finally { srv.stop(true); }
});

test("a spawn that fails leaves the card unlabelled", async () => {
  const { srv, post, add, card } = await server();
  try {
    const id = await add("Fix the thing");
    const res = await post("/action/spawn", { cwd: "/no/such/folder", text: "do the card", cardId: id });
    expect(((await res.json()) as any).ok).toBe(false);
    expect(card(id).repo).toBeUndefined();
  } finally { srv.stop(true); }
});

test("card-update sets and clears the repo by hand", async () => {
  const { srv, post, add, card } = await server();
  try {
    const id = await add("Fix the thing");
    expect((await post("/action/card-update", { cardId: id, repo: " budget.el " })).status).toBe(200);
    expect(card(id).repo).toBe("budget.el");
    expect((await post("/action/card-update", { cardId: id, repo: "" })).status).toBe(200);
    expect(card(id).repo).toBeUndefined();
    await post("/action/card-update", { cardId: id, repo: "x" });
    expect((await post("/action/card-update", { cardId: id, repo: null })).status).toBe(200);
    expect(card(id).repo).toBeUndefined();
  } finally { srv.stop(true); }
});

test("card-update refuses a repo that is not a string", async () => {
  const { srv, post, add } = await server();
  try {
    const id = await add("Fix the thing");
    const res = await post("/action/card-update", { cardId: id, repo: 7 });
    expect(res.status).toBe(400);
  } finally { srv.stop(true); }
});

// ---- the MCP tools --------------------------------------------------------------

function fakeApi() {
  const calls: { path: string; body?: unknown }[] = [];
  const api: Api = {
    async get(path) { calls.push({ path }); return { status: 200, body: { ok: true } }; },
    async post(path, body) { calls.push({ path, body }); return { status: 200, body: { ok: true } }; },
  };
  return { api, calls };
}
const ctx = (api: Api): Ctx => ({ api, author: "ANVIL", url: "http://localhost:4173" });

test("card_update sends a repo through to the board", async () => {
  const { api, calls } = fakeApi();
  await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_update", arguments: { cardId: "card_1", repo: "agent-smith" } } }, ctx(api));
  expect(calls[0]!.body).toEqual({ cardId: "card_1", repo: "agent-smith" });
});

test("formatCard names the repo, or says there is none", () => {
  const b = { columns: defaultBoard().columns, cards: [{ id: "card_1", title: "T", columnId: "backlog" }] } as Board;
  expect(formatCard(b, "card_1")).toContain("repo: (none)");
  expect(formatCard(setCardRepo(b, "card_1", "agent-smith", "/r/agent-smith"), "card_1")).toContain("repo: agent-smith (/r/agent-smith)");
});

test("formatBoard shows a card's repo on its line when it has one", () => {
  const b = { columns: defaultBoard().columns, cards: [{ id: "card_1", title: "T", columnId: "backlog" }] } as Board;
  expect(formatBoard(b)).not.toContain("repo:");
  expect(formatBoard(setCardRepo(b, "card_1", "agent-smith"))).toContain("[card_1] T  |  repo: agent-smith");
});
