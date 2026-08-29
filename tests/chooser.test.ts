import { test, expect } from "bun:test";
import { chooseFolderScript, trimFolderPath } from "../src/lib/chooser";

test("the script activates, prompts, and traps a user cancel", () => {
  const s = chooseFolderScript("Choose a repo folder");
  expect(s).toContain("activate");
  expect(s).toContain("choose folder with prompt");
  expect(s).toContain("on error number -128");
  expect(s).toContain("POSIX path of chosen");
  // no start folder given, so no default location clause at all
  expect(s).not.toContain("default location");
});

test("a start folder becomes a default location", () => {
  const s = chooseFolderScript("pick", "/Users/me/work");
  expect(s).toContain('default location (POSIX file ("/Users/me/work"))');
});

test("a quote in the start path can't break out of the AppleScript literal", () => {
  const s = chooseFolderScript("pick", '/tmp/we"ird');
  expect(s).not.toContain('/tmp/we"ird');
  expect(s).toContain('\\"');
});

test("trimFolderPath drops the trailing slash but never empties the root", () => {
  expect(trimFolderPath("/Users/me/work/")).toBe("/Users/me/work");
  expect(trimFolderPath("/Users/me/work")).toBe("/Users/me/work");
  expect(trimFolderPath("  /a/b/  ")).toBe("/a/b");
  expect(trimFolderPath("/")).toBe("/");
});
