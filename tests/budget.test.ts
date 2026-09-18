import { test, expect } from "bun:test";
import { firstTokensLeftIn, lastTokensLeftIn } from "../src/lib/budget";

const marker = (n: number | string) => `<total_tokens>${n} tokens left</total_tokens>`;

test("firstTokensLeftIn: the first marker in the text, not a later one", () => {
  expect(firstTokensLeftIn(`head ${marker(15_000_000)} ... tail ${marker(12_000)}`)).toBe(15_000_000);
});

test("lastTokensLeftIn: the newest marker in the text", () => {
  expect(lastTokensLeftIn(`head ${marker(15_000_000)} ... tail ${marker(12_000)}`)).toBe(12_000);
});

test("both: null when the text carries no marker", () => {
  expect(firstTokensLeftIn('{"type":"user","message":{"content":"hi"}}')).toBe(null);
  expect(lastTokensLeftIn('{"type":"user","message":{"content":"hi"}}')).toBe(null);
  expect(firstTokensLeftIn("")).toBe(null);
  expect(lastTokensLeftIn("")).toBe(null);
});

test("both: a truncated or malformed marker is not a match", () => {
  const partial = "<total_tokens>15000 tokens le";
  expect(firstTokensLeftIn(partial)).toBe(null);
  expect(lastTokensLeftIn(partial)).toBe(null);
  expect(firstTokensLeftIn(marker("lots"))).toBe(null);
  expect(lastTokensLeftIn(marker("15_000"))).toBe(null);
});

test("both: found inside a JSON transcript line", () => {
  const line = JSON.stringify({ type: "user", message: { content: `<system-reminder>${marker(14_900_000)}</system-reminder>` } });
  expect(firstTokensLeftIn(line)).toBe(14_900_000);
  expect(lastTokensLeftIn(line)).toBe(14_900_000);
});

test("repeated calls are independent (no sticky regex state)", () => {
  const text = `${marker(9)} ${marker(8)}`;
  expect(lastTokensLeftIn(text)).toBe(8);
  expect(lastTokensLeftIn(text)).toBe(8);
  expect(firstTokensLeftIn(text)).toBe(9);
  expect(firstTokensLeftIn(text)).toBe(9);
});
