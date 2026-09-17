// tests/fixtures.test.ts — the scratch-directory helper every other test file
// uses. Its whole job is that two `bun test` runs (two worktrees, two agents)
// never name the same directory, because each run's reset() starts by deleting
// the one it is about to use.
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fixtureDir, cleanupFixtures } from "./fixtures";

afterEach(() => cleanupFixtures());

test("a fixture dir lives under the OS temp dir and is named for its caller", () => {
  const dir = fixtureDir("server-test");
  expect(dirname(dir)).toBe(tmpdir());
  expect(basename(dir)).toContain("server-test");
});

test("the name carries this process's pid, so a second run can't collide", () => {
  expect(basename(fixtureDir("server-test")).endsWith(`-${process.pid}`)).toBe(true);
});

test("the same name is the same dir, different names are different dirs", () => {
  expect(fixtureDir("scan-test")).toBe(fixtureDir("scan-test"));
  expect(fixtureDir("scan-test")).not.toBe(fixtureDir("merge-test"));
});

test("a name that could escape the temp dir is refused", () => {
  expect(() => fixtureDir("../etc")).toThrow();
  expect(() => fixtureDir("a/b")).toThrow();
  expect(() => fixtureDir("")).toThrow();
});

test("fixtureDir only names a dir — creating it stays the caller's business", () => {
  expect(existsSync(fixtureDir("not-made-yet"))).toBe(false);
});

test("cleanupFixtures removes the dirs this process handed out", () => {
  const dir = fixtureDir("cleanup-test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.json"), "{}");
  cleanupFixtures();
  expect(existsSync(dir)).toBe(false);
});

test("a plain process cleans its dirs up when it exits", async () => {
  const marker = join(tmpdir(), `aw-exit-probe-${process.pid}`);
  const child = Bun.spawn(["bun", "-e", `
    import { writeFileSync, mkdirSync } from "node:fs";
    const { fixtureDir } = await import(${JSON.stringify(join(import.meta.dir, "fixtures.ts"))});
    const d = fixtureDir("exit-test");
    mkdirSync(d, { recursive: true });
    writeFileSync(${JSON.stringify(marker)}, d);
  `], { stdout: "ignore", stderr: "pipe" });
  await child.exited;
  expect(await new Response(child.stderr).text()).toBe("");
  const made = await Bun.file(marker).text();
  expect(made).toContain("exit-test");
  expect(existsSync(made)).toBe(false); // the child took its scratch dir with it
  rmSync(marker, { force: true });
});

// `bun test` never fires process exit handlers, so the hook above is not enough
// on its own: the run is swept by an afterAll in the preload named in
// bunfig.toml. This runs a real `bun test` to prove that wiring is in place.
test("a `bun test` run cleans its dirs up when it finishes", async () => {
  const home = fixtureDir("preload-check");
  mkdirSync(home, { recursive: true });
  const marker = join(home, "made.txt");
  writeFileSync(join(home, "child.test.ts"), `
    import { test, expect } from "bun:test";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { fixtureDir } from ${JSON.stringify(join(import.meta.dir, "fixtures.ts"))};
    test("makes a scratch dir", () => {
      const d = fixtureDir("preload-child");
      mkdirSync(d, { recursive: true });
      writeFileSync(${JSON.stringify(marker)}, d);
      expect(1).toBe(1);
    });
  `);
  const child = Bun.spawn(["bun", "test", join(home, "child.test.ts")], {
    cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "ignore",
  });
  await child.exited;
  expect(child.exitCode).toBe(0);
  const made = await Bun.file(marker).text();
  expect(made).toContain("preload-child");
  expect(existsSync(made)).toBe(false);
});
