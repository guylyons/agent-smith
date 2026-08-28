import { test, expect } from "bun:test";
import { matchChat } from "../src/lib/chatsearch";
import type { ChatMessage } from "../src/lib/conversation";

const M = (role: ChatMessage["role"], text: string): ChatMessage => ({ role, text });

test("matchChat finds a case-insensitive substring hit", () => {
  const r = matchChat([M("user", "Please fix the Accordion width bug")], "accordion");
  expect(r).not.toBeNull();
  expect(r!.snippet.toLowerCase()).toContain("accordion");
});

test("matchChat returns null when nothing matches", () => {
  expect(matchChat([M("user", "hello world")], "accordion")).toBeNull();
});

test("matchChat returns null for an empty query", () => {
  expect(matchChat([M("user", "hello")], "  ")).toBeNull();
});

test("matchChat prefers the most recent matching message", () => {
  const r = matchChat([
    M("user", "first mention of widget here"),
    M("assistant", "later reply about the widget again"),
  ], "widget");
  expect(r!.snippet).toContain("later reply");
});

test("matchChat skips tool activity lines (noise, not conversation)", () => {
  const r = matchChat([
    M("user", "let's talk about the palette"),
    M("tool", "Read palette.ts"),
  ], "palette");
  expect(r!.role).not.toBe("tool");
  expect(r!.snippet).toContain("let's talk");
});

test("matchChat clips a long message to a snippet around the match", () => {
  const long = "x".repeat(400) + " NEEDLE " + "y".repeat(400);
  const r = matchChat([M("user", long)], "needle");
  expect(r!.snippet.length).toBeLessThan(long.length);
  expect(r!.snippet.toLowerCase()).toContain("needle");
});
