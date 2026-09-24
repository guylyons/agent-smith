// tests/mention-chip.test.ts
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../src/ui/markdown";

const html = (text: string) => renderToStaticMarkup(renderMarkdown(text) as any);

test("a mention renders as a chip that keeps its @ text", () => {
  expect(html("@DALLAS is the shape stable?")).toContain('<span class="mention">@DALLAS</span> is the shape stable?');
  expect(html("ask **@ripley-3f2a** now")).toContain('<strong><span class="mention">@ripley-3f2a</span></strong>');
});

test("email-like text and code are not chips", () => {
  expect(html("mail a@b.com")).not.toContain("mention");
  expect(html("run `npm i @types/bun`")).not.toContain("mention");
});
