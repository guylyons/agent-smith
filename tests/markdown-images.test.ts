// tests/markdown-images.test.ts
import { test, expect } from "bun:test";
import { imageSrc } from "../src/ui/markdown";

test("an /uploads url passes through untouched", () => {
  expect(imageSrc("/uploads/abc-shot.png")).toBe("/uploads/abc-shot.png");
});

test("an absolute local path maps to the /uploads route", () => {
  // This is the important case: a ticket stores the real file path so an agent
  // reading .line.json can open it; the browser needs the served URL instead.
  expect(imageSrc("/var/folders/tmp/agent-workshop-uploads/x1-shot.png")).toBe("/uploads/x1-shot.png");
  expect(imageSrc("  /tmp/up/y.png  ")).toBe("/uploads/y.png");
});

test("a file:// url is treated as the path it is", () => {
  expect(imageSrc("file:///tmp/up/z.png")).toBe("/uploads/z.png");
});

test("a name needing escaping is encoded for the URL", () => {
  expect(imageSrc("/tmp/up/my shot.png")).toBe("/uploads/my%20shot.png");
});

test("http(s) urls are allowed", () => {
  expect(imageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
  expect(imageSrc("http://localhost:4173/uploads/a.png")).toBe("http://localhost:4173/uploads/a.png");
});

test("anything that could execute is refused", () => {
  // Refused srcs render as the alt text instead of reaching an <img>.
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "vbscript:msgbox",
    "relative/path.png",
    "",
    "   ",
  ]) {
    expect(imageSrc(bad)).toBeNull();
  }
});
