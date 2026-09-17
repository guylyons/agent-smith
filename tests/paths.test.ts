import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { statusDir, ensureStatusDir } from "../src/lib/paths";
import { existsSync, rmSync } from "node:fs";

test("statusDir honors AGENT_STATUS_DIR", () => {
  const dir = fixtureDir("paths-test");
  process.env.AGENT_STATUS_DIR = dir;
  expect(statusDir()).toBe(dir);
});

test("ensureStatusDir creates the directory", () => {
  const dir = fixtureDir("paths-ensure");
  rmSync(dir, { recursive: true, force: true });
  process.env.AGENT_STATUS_DIR = dir;
  expect(ensureStatusDir()).toBe(dir);
  expect(existsSync(dir)).toBe(true);
});
