// Save an image dropped/pasted into a session's chat to a temp file, so its path
// can be typed into the terminal as part of the prompt (Claude Code reads images
// referenced by path). Files are written and left in place — the OS clears its
// temp dir eventually, and we never delete so a late read still finds the file.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

// Allowed image types → file extension. Anything else is refused.
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export function uploadDir(): string {
  return process.env.AGENT_UPLOAD_DIR ?? join(tmpdir(), "agent-workshop-uploads");
}

export type SaveResult = { ok: true; path: string } | { ok: false; error: string };

let seq = 0;
function stamp(): string {
  seq = (seq + 1) % 1e6;
  return `${Date.now().toString(36)}-${seq.toString(36)}`;
}

// Keep the original basename for a recognizable path, but force the extension to
// match the declared type so Claude Code identifies the image correctly.
function baseName(name: string): string {
  const cleaned = name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "image";
}

export function saveUpload(name: string, type: string, dataBase64: string): SaveResult {
  const ext = EXT[type];
  if (!ext) return { ok: false, error: "unsupported image type" };
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length === 0) return { ok: false, error: "empty image" };
  if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, error: "image too large (max 10 MB)" };
  const dir = uploadDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stamp()}-${baseName(name)}.${ext}`);
  writeFileSync(path, buf);
  return { ok: true, path };
}
