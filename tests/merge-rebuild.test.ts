// tests/merge-rebuild.test.ts — MERGE of a UI change into the dashboard's own
// checkout rebuilds dist/ and tells open dashboards; a failed build keeps the
// old dist and says so on the card and in the snapshot (the client's toast).
import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { markWorktreeOwned } from "../src/lib/worktree";
import type { Builder } from "../src/lib/uiBuild";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = fixtureDir("merge-rebuild-status");
const repos = fixtureDir("merge-rebuild-repo");
rmSync(repos, { recursive: true, force: true });
let seq = 0;
const SESSION = "7c1e2f30-aaaa-4bbb-8ccc-ddddeeeeaaaa";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
}

/** A repo on main that the server serves dist/ from, with an old build in it,
 *  and a worktree whose branch changed `file`. */
async function repoWithWork(file: string): Promise<{ root: string; wt: string; dist: string }> {
  const root = join(repos, `r${seq++}`);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "old index");
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@t");
  await git(root, "config", "user.name", "t");
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "root");
  const wt = join(root, "wt");
  await git(root, "worktree", "add", "-q", "-b", "feature", wt, "HEAD");
  await markWorktreeOwned(wt);
  mkdirSync(join(wt, file, ".."), { recursive: true });
  writeFileSync(join(wt, file), "changed\n");
  await git(wt, "add", "-A");
  await git(wt, "commit", "-q", "-m", "the work");
  return { root, wt, dist };
}

async function start(file: string, build: Builder) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  const repo = await repoWithWork(file);
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { quit: async () => ({ ok: true }), distDir: repo.dist, buildUi: build });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  writeFileSync(join(dir, `${SESSION}.json`), JSON.stringify({
    sessionId: SESSION, name: "VOLT", role: "r", ticket: "#1", state: "idle",
    doing: "x", cwd: repo.wt, branch: "feature", updatedAt: 9_999_999_999_999,
  }));
  const { cardId } = (await (await post("/action/card-add", { columnId: "backlog", title: "Land it" })).json()) as any;
  await post("/action/card-assign", { cardId, sessionId: SESSION });
  const merge = () => post("/action/card-merge", { cardId, author: "You" }, { "sec-fetch-site": "same-origin" });
  return { server, base, merge, ...repo };
}

/** The first /events message: the snapshot a dashboard connecting now gets. */
async function snapshotNow(base: string): Promise<any> {
  const reader = (await fetch(`${base}/events`)).body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const i = buf.indexOf("\n\n");
    if (i >= 0 && buf.startsWith("data: ")) { await reader.cancel(); return JSON.parse(buf.slice(6, i)); }
    if (i >= 0) { buf = buf.slice(i + 2); continue; }
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buf += dec.decode(value);
  }
}

async function comments(base: string): Promise<string[]> {
  const { board } = (await (await fetch(`${base}/board`)).json()) as any;
  return board.cards[0].comments.map((c: any) => c.text);
}

/** The rebuild runs after the merge answers; wait for its note on the card. */
async function waitForComment(base: string, re: RegExp): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const hit = (await comments(base)).find((t) => re.test(t));
    if (hit) return hit;
    await Bun.sleep(25);
  }
  throw new Error(`no comment matching ${re}: ${(await comments(base)).join(" | ")}`);
}

test("merging a src/ui change rebuilds dist and bumps the UI version open dashboards see", async () => {
  const built: Builder = async (_cwd, out) => { writeFileSync(join(out, "index.html"), "new index"); return { ok: true }; };
  const t = await start("src/ui/App.tsx", built);
  const before = (await snapshotNow(t.base)).ui;
  expect(before.version).not.toBe("");

  expect(((await (await t.merge()).json()) as any).ok).toBe(true);
  expect(await waitForComment(t.base, /rebuilt/i)).toMatch(/reload/i);
  expect(readFileSync(join(t.dist, "index.html"), "utf8")).toBe("new index");
  const after = (await snapshotNow(t.base)).ui;
  expect(after.version).not.toBe(before.version);
  expect(after.failed).toBeUndefined();
  t.server.stop(true);
});

test("merging a docs-only change does not build", async () => {
  let calls = 0;
  const t = await start("docs/x.md", async () => { calls++; return { ok: true }; });
  const before = (await snapshotNow(t.base)).ui;
  expect(((await (await t.merge()).json()) as any).ok).toBe(true);
  await Bun.sleep(300);
  expect(calls).toBe(0);
  expect((await comments(t.base)).some((c) => /rebuil|build/i.test(c))).toBe(false);
  expect((await snapshotNow(t.base)).ui).toEqual(before);
  t.server.stop(true);
});

test("a failed build keeps the old dist, says why on the card, and flags it for a toast", async () => {
  const t = await start("src/ui/App.tsx", async () => ({ ok: false, error: "Could not resolve \"./Nope\"" }));
  const before = (await snapshotNow(t.base)).ui;
  expect(((await (await t.merge()).json()) as any).ok).toBe(true);
  expect(await waitForComment(t.base, /build failed/i)).toContain("Could not resolve");
  expect(readFileSync(join(t.dist, "index.html"), "utf8")).toBe("old index");
  const after = (await snapshotNow(t.base)).ui;
  expect(after.version).toBe(before.version);
  expect(after.failed.error).toContain("Could not resolve");
  expect(after.failed.at).toBeGreaterThan(0);
  t.server.stop(true);
});
