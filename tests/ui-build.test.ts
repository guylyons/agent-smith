import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { touchesUi, uiVersion, rebuildUi, rebuildAfterMerge, type Builder } from "../src/lib/uiBuild";

// --- which merges need a rebuild, without a repo -----------------------------

test("a merge that changes anything the UI bundle is built from needs a rebuild", () => {
  expect(touchesUi(["README.md", "src/ui/App.tsx"])).toBe(true);
  expect(touchesUi(["src/ui/styles.css"])).toBe(true);
  // The bundle imports src/lib, and the build reads the deps.
  expect(touchesUi(["src/lib/board.ts"])).toBe(true);
  expect(touchesUi(["src/server.ts"])).toBe(true);
  expect(touchesUi(["package.json"])).toBe(true);
  expect(touchesUi(["bun.lock"])).toBe(true);
});

test("a merge that leaves src/ and the deps alone does not", () => {
  expect(touchesUi([])).toBe(false);
  expect(touchesUi([""])).toBe(false);
  expect(touchesUi(["README.md", "docs/a.md", "tests/ui-build.test.ts"])).toBe(false);
  // Only the folder and files themselves, not names that merely look alike.
  expect(touchesUi(["srcx/a.ts", "docs/src/ui/a.md", "docs/package.json", "old/bun.lock", "package.json.bak"])).toBe(false);
});

test("the UI version follows dist/index.html, and is empty when nothing is built", () => {
  const d = fixtureDir("ui-version");
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  expect(uiVersion(d)).toBe("");
  writeFileSync(join(d, "index.html"), "<script src=a.js>");
  const a = uiVersion(d);
  expect(a).not.toBe("");
  writeFileSync(join(d, "index.html"), "<script src=b.js>");
  expect(uiVersion(d)).not.toBe(a);
});

// --- the build itself, with a stand-in builder --------------------------------

const scratch = fixtureDir("ui-build-test");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
let seq = 0;

/** A checkout with an old build in dist/. */
function checkout(): { root: string; dist: string } {
  const root = join(scratch, `c${seq++}`);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "old index");
  writeFileSync(join(dist, "index-old.js"), "old js");
  return { root, dist };
}

const leftovers = (root: string) => readdirSync(root).filter((n) => n !== "dist");

test("a good build lands in dist, index.html last, and old chunks stay for open tabs", async () => {
  const { root, dist } = checkout();
  const build: Builder = async (_cwd, out) => {
    writeFileSync(join(out, "index-new.js"), "new js");
    writeFileSync(join(out, "index.html"), "new index");
    return { ok: true };
  };
  const r = await rebuildUi(root, dist, build);
  expect(r).toEqual({ ok: true });
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("new index");
  expect(readFileSync(join(dist, "index-new.js"), "utf8")).toBe("new js");
  expect(existsSync(join(dist, "index-old.js"))).toBe(true);
  expect(leftovers(root)).toEqual([]); // the staging folder is gone
});

test("a failed build keeps the old dist untouched and reports why", async () => {
  const { root, dist } = checkout();
  const build: Builder = async (_cwd, out) => {
    // A half-written output must never reach dist.
    writeFileSync(join(out, "index.html"), "half");
    return { ok: false, error: "error: Could not resolve \"./Nope\"" };
  };
  const r = await rebuildUi(root, dist, build);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("Could not resolve");
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("old index");
  expect(readdirSync(dist).sort()).toEqual(["index-old.js", "index.html"]);
  expect(leftovers(root)).toEqual([]);
});

test("a builder that throws, or writes no index.html, is a failure too", async () => {
  const { root, dist } = checkout();
  const r1 = await rebuildUi(root, dist, async () => { throw new Error("bun not found"); });
  expect(r1).toEqual({ ok: false, error: expect.stringContaining("bun not found") });
  const r2 = await rebuildUi(root, dist, async () => ({ ok: true }));
  expect(r2.ok).toBe(false);
  expect(r2.error).toMatch(/index\.html/);
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("old index");
  expect(leftovers(root)).toEqual([]);
});

// --- after a real merge ------------------------------------------------------

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

/** A repo on main with dist/ ignored and an old build in it, plus a merge of
 *  a branch that changed `file`. Returns the merge commit. */
async function mergedRepo(file: string): Promise<{ root: string; dist: string; commit: string }> {
  const { root, dist } = checkout();
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@t");
  await git(root, "config", "user.name", "t");
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "root");
  await git(root, "checkout", "-q", "-b", "work");
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), "changed\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "work");
  await git(root, "checkout", "-q", "main");
  await git(root, "merge", "-q", "--no-ff", "-m", "Merge branch 'work'", "work");
  return { root, dist, commit: await git(root, "rev-parse", "HEAD") };
}

const counting = () => {
  let calls = 0;
  const build: Builder = async (_cwd, out) => {
    calls++;
    writeFileSync(join(out, "index.html"), "new index");
    return { ok: true };
  };
  return { build, calls: () => calls };
};

test("after a merge that touches src/ui, the served checkout is rebuilt", async () => {
  const { dist, commit } = await mergedRepo("src/ui/App.tsx");
  const b = counting();
  const r = await rebuildAfterMerge(dist, commit, b.build);
  expect(r).toEqual({ ran: true, ok: true });
  expect(b.calls()).toBe(1);
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("new index");
});

test("after a merge that only touches src/lib, the served checkout is rebuilt", async () => {
  const { dist, commit } = await mergedRepo("src/lib/thing.ts");
  const b = counting();
  expect(await rebuildAfterMerge(dist, commit, b.build)).toEqual({ ran: true, ok: true });
  expect(b.calls()).toBe(1);
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("new index");
});

test("a docs-only merge does not build", async () => {
  const { dist, commit } = await mergedRepo("docs/notes.md");
  const b = counting();
  expect(await rebuildAfterMerge(dist, commit, b.build)).toEqual({ ran: false });
  expect(b.calls()).toBe(0);
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("old index");
});

test("a merge the served checkout doesn't have (another repo, or no commit) does not build", async () => {
  const a = await mergedRepo("src/ui/App.tsx");
  const other = await mergedRepo("src/ui/Other.tsx"); // different content, so a different SHA
  const b = counting();
  expect(await rebuildAfterMerge(a.dist, other.commit, b.build)).toEqual({ ran: false });
  expect(await rebuildAfterMerge(a.dist, "", b.build)).toEqual({ ran: false });
  expect(b.calls()).toBe(0);
});

test("a failed build after a merge keeps the old dist and says why", async () => {
  const { dist, commit } = await mergedRepo("src/ui/App.tsx");
  const r = await rebuildAfterMerge(dist, commit, async () => ({ ok: false, error: "boom" }));
  expect(r).toEqual({ ran: true, ok: false, error: "boom" });
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("old index");
});

// --- the real bun build, on a tiny UI ----------------------------------------

function tinyUi(entry: string): { root: string; dist: string } {
  const c = checkout();
  mkdirSync(join(c.root, "src", "ui"), { recursive: true });
  writeFileSync(join(c.root, "src", "ui", "index.html"), `<!doctype html><script type="module" src="./index.ts"></script>`);
  writeFileSync(join(c.root, "src", "ui", "index.ts"), entry);
  return c;
}

test("bun build: a good UI replaces the old index", async () => {
  const { root, dist } = tinyUi(`console.log("hi");`);
  expect(await rebuildUi(root, dist)).toEqual({ ok: true });
  expect(readFileSync(join(dist, "index.html"), "utf8")).not.toBe("old index");
});

test("bun build: a broken UI keeps the old dist and says what broke", async () => {
  const { root, dist } = tinyUi(`import { x } from "./missing"; console.log(x);`);
  const r = await rebuildUi(root, dist);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("missing");
  // bun prints a "^" under the bad spot; alone it means nothing in a toast.
  expect(r.error).toStartWith("error:");
  expect(readdirSync(dist).sort()).toEqual(["index-old.js", "index.html"]);
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("old index");
});
