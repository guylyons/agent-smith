// The MOOD board — a free-form canvas the agents (and the human) use to say, at a
// glance, what is going on: what we're focused on, what's at risk, what's
// blocked on a question, what just landed. THE LINE says where each task is;
// this says what it all adds up to.
//
// Notes sit at canvas coordinates and can be joined by labelled links. A note
// may point at a LINE card, so the big picture stays one click from the detail.
// Persisted to `.mood.json` next to `.line.json`, so it rides the same file
// watcher into the live snapshot and any agent can read or write it.
//
// Like board.ts, every mutation is PURE (Mood -> Mood, never mutating its
// input) and nothing here is server-only: the browser bundles this module.
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

/** What a note is saying. Each kind has its own colour on the canvas; a
 *  `heading` is a big bare label for grouping an area of the board. */
export type MoodKind = "focus" | "idea" | "risk" | "question" | "done" | "note" | "heading";
export const MOOD_KINDS: readonly MoodKind[] = ["focus", "idea", "risk", "question", "done", "note", "heading"];

export type MoodNote = {
  id: string;
  kind: MoodKind;
  title: string;
  body?: string;
  /** Canvas position of the note's top-left corner, in canvas pixels. */
  x: number;
  y: number;
  /** Width in canvas pixels; height follows the text. */
  w: number;
  /** A LINE card this note is about. */
  cardId?: string;
  /** Who put it there ("You", or an agent's name). */
  by?: string;
  at: number;
};
export type MoodLink = { id: string; from: string; to: string; label?: string };
export type Mood = { notes: MoodNote[]; links: MoodLink[] };

const VERSION = 1;
export const NOTE_W = 220;
const MIN_W = 140;
const MAX_W = 640;
/** Keep everything on a canvas that can actually be scrolled to. */
const LIMIT = 20_000;
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const LABEL_MAX = 60;

export function emptyMood(): Mood {
  return { notes: [], links: [] };
}

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const coord = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(clamp(n, -LIMIT, LIMIT)) : 0);
const width = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(clamp(n, MIN_W, MAX_W)) : NOTE_W);
const isKind = (k: unknown): k is MoodKind => typeof k === "string" && (MOOD_KINDS as readonly string[]).includes(k);

// ---- sanitizers -------------------------------------------------------------

/** Repair one note read from disk or a request, or null if nothing usable. */
export function sanitizeNote(input: unknown): MoodNote | null {
  if (!input || typeof input !== "object") return null;
  const n = input as Record<string, unknown>;
  if (typeof n.id !== "string" || !n.id) return null;
  const title = typeof n.title === "string" ? n.title.slice(0, TITLE_MAX) : "";
  const note: MoodNote = {
    id: n.id,
    kind: isKind(n.kind) ? n.kind : "note",
    title,
    x: coord(n.x),
    y: coord(n.y),
    w: width(n.w),
    at: typeof n.at === "number" && Number.isFinite(n.at) ? n.at : 0,
  };
  if (typeof n.body === "string" && n.body) note.body = n.body.slice(0, BODY_MAX);
  if (typeof n.cardId === "string" && n.cardId) note.cardId = n.cardId;
  if (typeof n.by === "string" && n.by) note.by = n.by;
  return note;
}

/** Repair a whole mood board. Links whose ends are missing, self-links and
 *  duplicate pairs are dropped, so the canvas never draws an arrow to nowhere. */
export function sanitizeMood(input: unknown): Mood {
  if (!input || typeof input !== "object") return emptyMood();
  const raw = input as Record<string, unknown>;
  const notes: MoodNote[] = [];
  const ids = new Set<string>();
  for (const n of Array.isArray(raw.notes) ? raw.notes : []) {
    const clean = sanitizeNote(n);
    if (clean && !ids.has(clean.id)) { ids.add(clean.id); notes.push(clean); }
  }
  const links: MoodLink[] = [];
  const pairs = new Set<string>();
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    if (!l || typeof l !== "object") continue;
    const { id, from, to, label } = l as Record<string, unknown>;
    if (typeof id !== "string" || typeof from !== "string" || typeof to !== "string") continue;
    if (from === to || !ids.has(from) || !ids.has(to)) continue;
    const key = pairKey(from, to);
    if (pairs.has(key)) continue;
    pairs.add(key);
    const link: MoodLink = { id, from, to };
    if (typeof label === "string" && label.trim()) link.label = label.trim().slice(0, LABEL_MAX);
    links.push(link);
  }
  return { notes, links };
}

/** One link per pair of notes, whichever way it points. */
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ---- pure mutations ---------------------------------------------------------

export type NoteInput = {
  title: string;
  x: number;
  y: number;
  kind?: MoodKind;
  body?: string;
  w?: number;
  cardId?: string;
  by?: string;
};

/** Add a note; returns the new board and the note's id. */
export function addNote(mood: Mood, input: NoteInput, now = Date.now()): { mood: Mood; id: string } {
  const id = genId("note");
  const note = sanitizeNote({ ...input, id, at: now })!;
  return { mood: { ...mood, notes: [...mood.notes, note] }, id };
}

export type NotePatch = Partial<Pick<MoodNote, "title" | "body" | "kind" | "x" | "y" | "w">> & { cardId?: string | null };

/** Change some of a note's fields; fields left out are untouched. An empty
 *  body or a null cardId clears it. Unknown ids are a no-op. */
export function updateNote(mood: Mood, id: string, patch: NotePatch): Mood {
  return {
    ...mood,
    notes: mood.notes.map((n) => {
      if (n.id !== id) return n;
      const merged: Record<string, unknown> = { ...n };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
      if (patch.cardId === null) delete merged.cardId;
      return sanitizeNote(merged) ?? n;
    }),
  };
}

/** Move a note to the end of the list, which is the top of the canvas. */
export function raiseNote(mood: Mood, id: string): Mood {
  const n = mood.notes.find((k) => k.id === id);
  if (!n || mood.notes[mood.notes.length - 1] === n) return mood;
  return { ...mood, notes: [...mood.notes.filter((k) => k.id !== id), n] };
}

/** Remove a note and every link touching it. */
export function deleteNote(mood: Mood, id: string): Mood {
  return {
    notes: mood.notes.filter((n) => n.id !== id),
    links: mood.links.filter((l) => l.from !== id && l.to !== id),
  };
}

/** Put a deleted note back with the links that went down with it — the undo
 *  half of deleteNote. No-op if the note is already back; links whose other
 *  end has since gone are dropped. */
export function restoreNote(mood: Mood, note: MoodNote, links: MoodLink[]): Mood {
  if (mood.notes.some((n) => n.id === note.id)) return mood;
  return sanitizeMood({ notes: [...mood.notes, note], links: [...mood.links, ...links] });
}

/** Why a link can't be made, or null when it can. */
export function linkBlockReason(mood: Mood, from: string, to: string): string | null {
  if (from === to) return "a note can't link to itself";
  if (!mood.notes.some((n) => n.id === from)) return `unknown note: ${from}`;
  if (!mood.notes.some((n) => n.id === to)) return `unknown note: ${to}`;
  if (mood.links.some((l) => pairKey(l.from, l.to) === pairKey(from, to))) return "those notes are already linked";
  return null;
}

/** Link two notes. A link that can't be made (see linkBlockReason) is a no-op
 *  and returns no id. */
export function addLink(mood: Mood, from: string, to: string, label?: string): { mood: Mood; id?: string } {
  if (linkBlockReason(mood, from, to)) return { mood };
  const id = genId("link");
  const link: MoodLink = { id, from, to };
  if (label?.trim()) link.label = label.trim().slice(0, LABEL_MAX);
  return { mood: { ...mood, links: [...mood.links, link] }, id };
}

export function setLinkLabel(mood: Mood, id: string, label: string): Mood {
  return {
    ...mood,
    links: mood.links.map((l) => {
      if (l.id !== id) return l;
      const { label: _old, ...rest } = l;
      return label.trim() ? { ...rest, label: label.trim().slice(0, LABEL_MAX) } : rest;
    }),
  };
}

export function deleteLink(mood: Mood, id: string): Mood {
  return { ...mood, links: mood.links.filter((l) => l.id !== id) };
}

// ---- geometry -----------------------------------------------------------------

/** The box every note sits in, or null for an empty board. Heights are not
 *  stored, so each note is assumed `noteH` tall. */
export function moodBounds(mood: Mood, noteH = 120): { x: number; y: number; w: number; h: number } | null {
  if (!mood.notes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of mood.notes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + noteH);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Where the line from `r`'s centre toward point (tx, ty) leaves `r` — so an
 *  arrow between two notes starts and ends at their edges, not under them. */
export function rectEdgePoint(r: Rect, tx: number, ty: number): { x: number; y: number } {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? (r.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy ? (r.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Zoom by `factor` about a screen point, keeping the canvas point under it
 *  still. `view` maps canvas to screen as screen = canvas * z + (x, y). */
export function zoomAt(view: { x: number; y: number; z: number }, factor: number, sx: number, sy: number, min = 0.2, max = 2.5): { x: number; y: number; z: number } {
  const z = clamp(view.z * factor, min, max);
  const k = z / view.z;
  return { x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k, z };
}

/** The view that fits `bounds` inside a `vw` x `vh` viewport with `pad`
 *  pixels to spare, never zooming in past 1:1. */
export function fitView(bounds: Rect | null, vw: number, vh: number, pad = 48): { x: number; y: number; z: number } {
  if (!bounds || vw <= 0 || vh <= 0) return { x: pad, y: pad, z: 1 };
  const z = clamp(Math.min((vw - pad * 2) / bounds.w, (vh - pad * 2) / bounds.h, 1), 0.2, 1);
  return { x: (vw - bounds.w * z) / 2 - bounds.x * z, y: (vh - bounds.h * z) / 2 - bounds.y * z, z };
}

// ---- agent-readable summary ---------------------------------------------------

/** The board as plain text, for an agent: every note with its id, grouped by
 *  kind, then every link. */
export function formatMood(mood: Mood): string {
  if (!mood.notes.length) return "The mood board is empty.";
  const title = (id: string) => mood.notes.find((n) => n.id === id)?.title || id;
  const lines: string[] = [`MOOD BOARD — ${mood.notes.length} notes, ${mood.links.length} links`];
  for (const kind of MOOD_KINDS) {
    const notes = mood.notes.filter((n) => n.kind === kind);
    if (!notes.length) continue;
    lines.push("", `${kind.toUpperCase()}:`);
    for (const n of notes) {
      const extra = [n.cardId ? `card ${n.cardId}` : "", n.by ? `by ${n.by}` : ""].filter(Boolean).join(", ");
      lines.push(`- ${n.id} "${n.title}"${extra ? ` (${extra})` : ""} at ${n.x},${n.y}`);
      if (n.body) lines.push(...n.body.split("\n").map((l) => `    ${l}`));
    }
  }
  if (mood.links.length) {
    lines.push("", "LINKS:");
    for (const l of mood.links) lines.push(`- ${l.id}: "${title(l.from)}" -> "${title(l.to)}"${l.label ? ` [${l.label}]` : ""}`);
  }
  return lines.join("\n");
}

// ---- persistence ----------------------------------------------------------------

export function moodFile(dir: string): string {
  return join(dir, ".mood.json");
}

export function readMood(dir: string): Mood {
  try {
    return sanitizeMood(JSON.parse(readFileSync(moodFile(dir), "utf8")));
  } catch {
    return emptyMood(); // missing or corrupt
  }
}

export function writeMood(dir: string, mood: Mood): void {
  const clean = sanitizeMood(mood);
  const tmp = moodFile(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: VERSION, ...clean }));
  renameSync(tmp, moodFile(dir));
}
