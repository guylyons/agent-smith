// tests/markdown-lists.test.ts
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../src/ui/markdown";

function html(text: string): string {
  return renderToStaticMarkup(renderMarkdown(text) as any);
}

test("a loose ordered list with indented continuation paragraphs stays one sequential list", () => {
  const text = [
    "1. First item.",
    "",
    "    Indented continuation line.",
    "",
    "2. Second item.",
    "",
    "    Indented continuation line.",
    "",
    "3. Third item.",
  ].join("\n");

  const out = html(text);

  // Exactly one <ol> — the three items must not split into three separate lists
  // (each of which would restart numbering at 1).
  expect((out.match(/<ol/g) ?? []).length).toBe(1);
  expect((out.match(/<li/g) ?? []).length).toBe(3);
  expect(out).toContain("First item.");
  expect(out).toContain("Second item.");
  expect(out).toContain("Third item.");
  expect(out).toContain("Indented continuation line.");
});

test("a tight ordered list with no continuation still renders as one list", () => {
  const out = html("1. a\n2. b\n3. c");
  expect((out.match(/<ol/g) ?? []).length).toBe(1);
  expect((out.match(/<li/g) ?? []).length).toBe(3);
});

test("an ordered list followed by an unrelated paragraph does not absorb it", () => {
  const out = html("1. a\n2. b\n\nSome paragraph.");
  expect((out.match(/<ol/g) ?? []).length).toBe(1);
  expect((out.match(/<li/g) ?? []).length).toBe(2);
  expect(out).toContain("<p>Some paragraph.</p>");
});

test("an unordered list with a blank-line continuation also stays one list", () => {
  const out = html(["- a", "", "    cont a", "", "- b"].join("\n"));
  expect((out.match(/<ul/g) ?? []).length).toBe(1);
  expect((out.match(/<li/g) ?? []).length).toBe(2);
});
