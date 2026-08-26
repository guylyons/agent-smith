import { test, expect } from "bun:test";
import { statusDir, ensureStatusDir } from "../src/lib/paths";
import { existsSync, rmSync } from "node:fs";

test("statusDir honors AGENT_STATUS_DIR", () => {
  process.env.AGENT_STATUS_DIR = "/tmp/aw-test-dir";
  expect(statusDir()).toBe("/tmp/aw-test-dir");
});

test("ensureStatusDir creates the directory", () => {
  const dir = "/tmp/aw-test-ensure";
  rmSync(dir, { recursive: true, force: true });
  process.env.AGENT_STATUS_DIR = dir;
  expect(ensureStatusDir()).toBe(dir);
  expect(existsSync(dir)).toBe(true);
});
