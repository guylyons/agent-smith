import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import { prepareSandbox, sandboxLeakWarning, sandboxOps } from "../src/lib/sandbox";

const HOME = "/Users/someone";

test("sandboxLeakWarning: default dirs are the live board, not a leak", () => {
  expect(sandboxLeakWarning({}, HOME)).toBeNull();
});

test("sandboxLeakWarning: a custom status dir with the real projects dir warns", () => {
  const w = sandboxLeakWarning({ AGENT_STATUS_DIR: "/tmp/sb" }, HOME);
  expect(w).toContain("AGENT_PROJECTS_DIR");
  expect(w).toContain(join(HOME, ".claude", "projects"));
});

test("sandboxLeakWarning: naming the real projects dir outright still warns", () => {
  const env = { AGENT_STATUS_DIR: "/tmp/sb", AGENT_PROJECTS_DIR: join(HOME, ".claude", "projects/") };
  expect(sandboxLeakWarning(env, HOME)).not.toBeNull();
});

test("sandboxLeakWarning: both dirs overridden is isolated", () => {
  expect(sandboxLeakWarning({ AGENT_STATUS_DIR: "/tmp/sb", AGENT_PROJECTS_DIR: "/tmp/empty" }, HOME)).toBeNull();
});

test("sandboxLeakWarning: status dir set to the default path is not a sandbox", () => {
  expect(sandboxLeakWarning({ AGENT_STATUS_DIR: join(HOME, ".agent-status") }, HOME)).toBeNull();
});

test("sandboxOps: every terminal action is a no-op that says sandbox", async () => {
  const t = { sessionId: "s", name: "X", state: "idle" } as never;
  expect(await sandboxOps.deliver(t, "hi")).toEqual({ ok: false, error: "sandbox" });
  expect(await sandboxOps.deliverFresh(t, "hi")).toEqual({ ok: false, error: "sandbox" });
  expect(await sandboxOps.quit(t)).toEqual({ ok: false, error: "sandbox" });
  expect(await sandboxOps.spawn("/tmp", "task")).toEqual({ ok: false, error: "sandbox" });
});

test("prepareSandbox copies the board and nothing else, and makes an empty projects dir", () => {
  const live = fixtureDir("sandbox-live");
  const root = fixtureDir("sandbox-root");
  rmSync(live, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, ".line.json"), '{"columns":[],"cards":[]}');
  writeFileSync(join(live, "abc.json"), '{"sessionId":"abc"}'); // a live desk: must not come along
  const env = prepareSandbox(live, root);
  expect(env.AGENT_STATUS_DIR.startsWith(root)).toBe(true);
  expect(env.AGENT_PROJECTS_DIR.startsWith(root)).toBe(true);
  expect(readFileSync(join(env.AGENT_STATUS_DIR, ".line.json"), "utf8")).toBe('{"columns":[],"cards":[]}');
  expect(readdirSync(env.AGENT_STATUS_DIR)).toEqual([".line.json"]);
  expect(readdirSync(env.AGENT_PROJECTS_DIR)).toEqual([]);
  expect(sandboxLeakWarning(env, HOME)).toBeNull();
});

test("prepareSandbox with no live board starts from an empty status dir", () => {
  const live = fixtureDir("sandbox-live-none");
  const root = fixtureDir("sandbox-root-none");
  rmSync(live, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  const env = prepareSandbox(live, root);
  expect(existsSync(env.AGENT_STATUS_DIR)).toBe(true);
  expect(readdirSync(env.AGENT_STATUS_DIR)).toEqual([]);
});
