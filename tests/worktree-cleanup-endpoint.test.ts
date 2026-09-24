// tests/worktree-cleanup-endpoint.test.ts — the CONFIG sweep over HTTP: the
// repos come from the board and the agents, live agents' worktrees are kept,
// and only a human's same-origin confirm removes anything.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import { writeBoard } from "../src/lib/board";

const dir = fixtureDir("worktree-cleanup-endpoint");
const status = join(dir, "status");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function worktree(root: string, branch: string, merge: boolean): Promise<string> {
  const wt = join(root, ".claude", "worktrees", branch);
  await git(root, "worktree", "add", "-q", "-b", branch, wt, "HEAD");
  writeFileSync(join(wt, `${branch}.txt`), `${branch}\n`);
  await git(wt, "add", "-A");
  await git(wt, "commit", "-q", "-m", branch);
  if (merge) await git(root, "merge", "-q", "--no-ff", "--no-edit", branch);
  return wt;
}

async function start() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(status, { recursive: true });
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@t");
  await git(root, "config", "user.name", "t");
  writeFileSync(join(root, "README"), "root\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "root");
  const done = await worktree(root, "ag-done", true);
  const busy = await worktree(root, "ag-busy", true);
  const open = await worktree(root, "ag-open", false);

  // The board knows the repo through a card's repoPath; an agent sits in ag-busy.
  writeBoard(status, {
    columns: [{ id: "backlog", name: "Backlog", instruction: "" }],
    cards: [{ id: "k1", title: "K1", columnId: "backlog", repo: "repo", repoPath: root }],
  });
  writeFileSync(join(status, "a.json"), JSON.stringify({
    sessionId: "a", name: "A", role: "r", ticket: null, state: "working",
    doing: "x", cwd: busy, branch: "ag-busy", updatedAt: Date.now(),
  }));

  process.env.AGENT_STATUS_DIR = status;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { quit: async () => ({ ok: true }) });
  const post = (body: object, headers: Record<string, string> = {}) =>
    fetch(`http://localhost:${server.port}/action/worktree-cleanup`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
  return { server, post, root, done, busy, open };
}

test("the preview lists what can go and why the rest stays, and removes nothing", async () => {
  const { server, post, done } = await start();
  const res = await post({});
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.ok).toBe(true);
  expect(body.remove.map((w: any) => w.branch)).toEqual(["ag-done"]);
  const why = Object.fromEntries(body.keep.map((w: any) => [w.branch, w.why]));
  expect(why["ag-busy"]).toMatch(/agent is working in it/);
  expect(why["ag-open"]).toMatch(/not merged/);
  expect(existsSync(done)).toBe(true);
  server.stop(true);
});

test("a confirm from the dashboard removes the listed worktree and reports the rest", async () => {
  const { server, post, root, done, busy, open } = await start();
  const preview = (await (await post({})).json()) as any;
  const res = await post({ remove: preview.remove.map((w: any) => w.path) }, { "sec-fetch-site": "same-origin" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.ok).toBe(true);
  expect(body.removed.map((w: any) => w.branch)).toEqual(["ag-done"]);
  // The ones that stay are reported too, with why, so the panel can say so.
  const why = Object.fromEntries(body.kept.map((w: any) => [w.branch, w.why]));
  expect(why["ag-busy"]).toMatch(/agent is working in it/);
  expect(why["ag-open"]).toMatch(/not merged/);
  expect(existsSync(done)).toBe(false);
  expect(existsSync(busy)).toBe(true);
  expect(existsSync(open)).toBe(true);
  expect(await git(root, "branch", "--list", "ag-done")).toBe("");
  server.stop(true);
});

test("removing is a human's call: a confirm that isn't from the dashboard is refused", async () => {
  const { server, post, done } = await start();
  const preview = (await (await post({})).json()) as any;
  const res = await post({ remove: preview.remove.map((w: any) => w.path) });
  expect(res.status).toBe(403);
  expect(existsSync(done)).toBe(true);
  server.stop(true);
});
