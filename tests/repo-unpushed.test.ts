import { test, expect } from "bun:test";
import { countUnpushed } from "../src/repo";
import { mkdirSync, rmSync } from "node:fs";

const root = "/tmp/aw-unpushed-test";
async function git(cwd: string, args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

test("counts local commits absent from every remote", async () => {
  rmSync(root, { recursive: true, force: true });
  const remote = `${root}/remote.git`;
  const work = `${root}/work`;
  mkdirSync(remote, { recursive: true });
  mkdirSync(work, { recursive: true });

  await git(remote, ["init", "--bare"]);
  await git(work, ["init"]);
  await git(work, ["config", "user.email", "t@t"]);
  await git(work, ["config", "user.name", "t"]);
  await git(work, ["remote", "add", "origin", remote]);

  // A brand-new branch with a commit, never pushed -> unpushed.
  await Bun.write(`${work}/a.txt`, "1");
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-m", "first"]);
  expect(await countUnpushed(work)).toBeGreaterThan(0);

  // After pushing, nothing is unpushed.
  await git(work, ["push", "-u", "origin", "HEAD"]);
  expect(await countUnpushed(work)).toBe(0);

  // A further local commit is unpushed again.
  await Bun.write(`${work}/b.txt`, "2");
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-m", "second"]);
  expect(await countUnpushed(work)).toBe(1);
});

test("a non-git dir yields 0, never throws", async () => {
  expect(await countUnpushed("/tmp")).toBe(0);
});
