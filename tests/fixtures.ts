// tests/fixtures.ts — scratch directories that belong to one test run.
//
// Test files used to name their scratch dirs as literals (/tmp/aw-server-test,
// /tmp/aw-scan-test, ...). Those names are shared by every process on the
// machine, and nearly every test opens with reset() -> rmSync(dir), so two
// checkouts running `bun test` at the same time — the normal case here, where
// agents work in parallel worktrees — deleted each other's fixtures mid-run.
// Stamping the process id into the name makes the runs independent, and an
// exit hook keeps them from piling up one directory per pid.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Slug rules: what can appear between "aw-" and the pid. Anything with a
 *  separator, a dot segment, or spaces is refused — this name is handed to
 *  rmSync, so it must not be able to point outside the temp dir. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;

/** The directory name for a run, given its scope and process — the pure part. */
export function fixtureDirName(name: string, pid: number): string {
  if (!NAME_RE.test(name)) throw new Error(`bad fixture name: ${JSON.stringify(name)}`);
  return `aw-${name}-${pid}`;
}

/** Every dir this process has handed out, so exit can take them all away. */
const owned = new Set<string>();
let hooked = false;

/**
 * The scratch dir this run owns for `name`, e.g. aw-server-test-40127 under the
 * OS temp dir. Stable within a process and unique across processes. It is only
 * named, not created: callers make it themselves, usually in a reset() that
 * wipes it first.
 */
export function fixtureDir(name: string): string {
  const dir = join(tmpdir(), fixtureDirName(name, process.pid));
  owned.add(dir);
  if (!hooked) {
    hooked = true;
    process.on("exit", cleanupFixtures);
  }
  return dir;
}

/** Remove every fixture dir this process owns. Runs on exit; safe to call
 *  early, and safe on dirs that were never created. */
export function cleanupFixtures(): void {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
  owned.clear();
}
