// tests/uploads.test.ts
import { test, expect, beforeEach } from "bun:test";
import { saveUpload, uploadDir, MAX_UPLOAD_BYTES } from "../src/lib/uploads";
import { rmSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const dir = "/tmp/aw-upload-test";
process.env.AGENT_UPLOAD_DIR = dir;

beforeEach(() => rmSync(dir, { recursive: true, force: true }));

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("saveUpload writes a file and returns its path", () => {
  const r = saveUpload("shot.png", "image/png", b64("PNGDATA"));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(dirname(r.path)).toBe(dir);
  expect(r.path.endsWith(".png")).toBe(true);
  expect(readFileSync(r.path, "utf8")).toBe("PNGDATA");
});

test("saveUpload forces the extension to match the declared type", () => {
  // A screenshot pasted with a .jpeg name but declared as png gets a .png path.
  const r = saveUpload("clipboard.jpeg", "image/png", b64("x"));
  expect(r.ok && r.path.endsWith(".png")).toBe(true);
});

test("saveUpload sanitizes the basename", () => {
  const r = saveUpload("../../etc/pa ss.png", "image/png", b64("x"));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(dirname(r.path)).toBe(dir); // no path traversal
  expect(r.path).not.toContain(" ");
});

test("saveUpload refuses an unsupported type", () => {
  const r = saveUpload("evil.svg", "image/svg+xml", b64("<svg>"));
  expect(r).toEqual({ ok: false, error: "unsupported image type" });
});

test("saveUpload refuses an empty image", () => {
  const r = saveUpload("empty.png", "image/png", "");
  expect(r).toEqual({ ok: false, error: "empty image" });
});

test("saveUpload refuses an oversize image", () => {
  const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64");
  const r = saveUpload("big.png", "image/png", big);
  expect(r).toEqual({ ok: false, error: "image too large (max 10 MB)" });
});

test("uploadDir honors AGENT_UPLOAD_DIR", () => {
  expect(uploadDir()).toBe(dir);
});
