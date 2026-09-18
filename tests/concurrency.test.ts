// tests/concurrency.test.ts — card writes and merges fired at the real HTTP
// server without awaiting between them.
//
// Each card-* handler in src/server.ts does readBoard -> pure op -> writeBoard
// with no await in between, so on Bun's single event loop no other request can
// run inside that window. That is an invariant of the code's shape, not
// something the type checker sees: an await slipped in between the read and the
// write (a remote check, a log flush) would let two requests read the same
// board, and the second write would erase the first. These tests catch that.
import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = fixtureDir("concurrency-test");

async function startServer() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const board = async () => ((await (await fetch(`${base}/board`)).json()) as any).board;
  return { server, post, board };
}

// --- card-move / card-comment ------------------------------------------------

test("concurrent card-move and card-comment requests lose no writes", async () => {
  const { server, post, board } = await startServer();

  // Cards to move, and one card to pile comments on. Every request below
  // touches a different part of the board, so each one's write must survive.
  const moved: string[] = [];
  for (let i = 0; i < 8; i++) {
    const out = (await (await post("/action/card-add", { columnId: "backlog", title: `move ${i}` })).json()) as any;
    moved.push(out.cardId);
  }
  const talk = ((await (await post("/action/card-add", { columnId: "backlog", title: "talk" })).json()) as any).cardId;

  // Fire everything at once: no await between the requests.
  const results = await Promise.all([
    ...moved.map((cardId) => post("/action/card-move", { cardId, toColumnId: "done", author: "A" })),
    ...Array.from({ length: 8 }, (_, i) => post("/action/card-comment", { cardId: talk, author: "B", text: `note ${i}` })),
  ]);
  for (const r of results) expect(r.status).toBe(200);

  const after = await board();
  const byId = new Map(after.cards.map((c: any) => [c.id, c]));
  for (const id of moved) expect((byId.get(id) as any).columnId).toBe("done");
  const notes = ((byId.get(talk) as any).comments ?? []).map((c: any) => c.text).sort();
  expect(notes).toEqual(Array.from({ length: 8 }, (_, i) => `note ${i}`).sort());
  server.stop(true);
});

// --- card-merge ---------------------------------------------------------------
// Two cards whose work lives in two worktrees of ONE repo, merged at once
// through the real endpoint. mergeWork queues per repo root, so both must land;
// without that queue they collide on the shared checkout (index.lock, or one
// merge's half-done state failing the other's re-check).

const repoBase = fixtureDir("concurrency-merge-repo");

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

/** A status file saying session `sessionId` (named `name`) works in `cwd`. */
function status(sessionId: string, name: string, cwd: string, branch: string) {
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({
    sessionId, name, role: "r", ticket: "#1", state: "working", doing: "x",
    cwd, branch, updatedAt: 9_999_999_999_999,
  }));
}

test("two card-merge calls into the same repo both land, one after the other", async () => {
  const { server, post, board } = await startServer();

  rmSync(repoBase, { recursive: true, force: true });
  const root = join(repoBase, "repo");
  mkdirSync(root, { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@t");
  await git(root, "config", "user.name", "t");
  writeFileSync(join(root, "README"), "root\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "root");

  const sessions = [
    { id: "7c1e2f30-aaaa-4bbb-8ccc-000000000001", name: "VOLT", branch: "ag-one", file: "one.txt" },
    { id: "7c1e2f30-aaaa-4bbb-8ccc-000000000002", name: "ANVIL", branch: "ag-two", file: "two.txt" },
  ];
  const cards: string[] = [];
  for (const s of sessions) {
    const wt = join(root, ".wt", s.branch);
    await git(root, "worktree", "add", "-q", "-b", s.branch, wt, "HEAD");
    writeFileSync(join(wt, s.file), `${s.branch}\n`);
    await git(wt, "add", "-A");
    await git(wt, "commit", "-q", "-m", `work on ${s.branch}`);
    status(s.id, s.name, wt, s.branch);
    const { cardId } = (await (await post("/action/card-add", { columnId: "review", title: s.branch })).json()) as any;
    await post("/action/card-assign", { cardId, sessionId: s.id });
    cards.push(cardId);
  }

  // Both MERGE presses at once, as the browser would send them.
  const results = await Promise.all(cards.map((cardId) =>
    post("/action/card-merge", { cardId, author: "You" }, { "sec-fetch-site": "same-origin" }).then((r) => r.json())));

  expect(results.map((r: any) => [r.ok, r.branch])).toEqual([[true, "ag-one"], [true, "ag-two"]]);
  expect(existsSync(join(root, "one.txt"))).toBe(true);
  expect(existsSync(join(root, "two.txt"))).toBe(true);

  // Two real merge commits on main, one per branch.
  const log = Bun.spawnSync(["git", "-C", root, "log", "--merges", "--pretty=%s", "main"]).stdout.toString();
  expect(log).toContain("Merge branch 'ag-one'");
  expect(log).toContain("Merge branch 'ag-two'");

  // And each card carries its own record of the merge.
  const after = await board();
  for (const [i, cardId] of cards.entries()) {
    const card = after.cards.find((c: any) => c.id === cardId);
    expect(card.comments.map((c: any) => c.text)).toContain(`Merged ${sessions[i]!.branch} into main.`);
  }
  server.stop(true);
});
