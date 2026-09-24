// The shapes of the POST /action/* request bodies, one named zod schema per
// action (or per family of actions), read by the handlers in src/server.ts.
//
// Server-only, so it can use zod like src/schema.ts does. The board's own
// sanitizers in src/lib/board.ts can't: that module is bundled into the
// browser (see the note above its sanitizeAssignee).
//
// These are deliberately lenient in the way the inline checks they replaced
// were: a field of the wrong type falls back to a default (`.catch`) rather
// than failing the request, and only the fields an action actually refuses
// on carry an error — worded exactly as the handler has always worded it.
// When a body breaks more than one rule, the first rule in declaration order
// is the one reported (see parseBody), so field order here is load-bearing.
//
// Checks that need the board, the filesystem or a live session stay in the
// handlers; these only judge the body itself.
import { z } from "zod";
import { STAGES, sanitizeCard, sanitizeColumn, type Card, type Column, type Stage } from "./board";
import { MOOD_KINDS, sanitizeNote, type MoodKind, type MoodNote } from "./mood";
import { BODY_MAX, BY_MAX, MAX_LINKS, MAX_TAGS } from "./memory";
import { ALLOWED_MODELS, ALLOWED_PERMISSION_MODES } from "../ghostty";

/** A body's fields, or the message of the first rule it broke. A body that
 *  isn't a JSON object at all is a "bad body", as an unparseable one is. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): { data: z.output<S> } | { error: string } {
  const r = schema.safeParse(body);
  return r.success ? { data: r.data } : { error: r.error.issues[0]?.message ?? "bad body" };
}

/** Every action body is a JSON object; anything else is refused whole. */
const body = <T extends z.core.$ZodLooseShape>(shape: T) => z.object(shape, { error: "bad body" });

// ---- field kinds ------------------------------------------------------------

/** A string, or "" when absent or not a string. */
const text = () => z.string().catch("");
/** A string, trimmed; "" when absent or not a string. */
const trimmed = () => z.string().catch("").transform((s) => s.trim());
/** A string, or undefined when absent or not a string. Presence matters to
 *  the caller (a field left out is left alone). */
const maybeText = () => z.string().optional().catch(undefined);
/** A trimmed string, or undefined when absent, blank or not a string. */
const maybeTrimmed = () => trimmed().transform((s) => s || undefined);
/** true only for an explicit `true` — the human's override flags. */
const flag = () => z.boolean().catch(false);
/** A string that must be non-empty, refused with `message` otherwise. */
const required = (message: string) => z.string({ error: message }).min(1, { error: message });
/** One of an allowed set, or undefined for anything else. */
const oneOf = (allowed: ReadonlySet<string>) =>
  z.string().refine((s) => allowed.has(s)).optional().catch(undefined);
/** Raw input repaired by one of board.ts's sanitizers; refused with `message`
 *  when there is nothing usable in it. */
const sanitized = <T>(sanitize: (v: unknown) => T | null, message: string) =>
  z.unknown().transform((v, ctx): T => {
    const clean = sanitize(v);
    if (clean === null) {
      ctx.issues.push({ code: "custom", message, input: v });
      return z.NEVER;
    }
    return clean;
  });

// sessionId comes from the client; keep it to a single, safe path/key segment.
export const SESSION_ID_RE = /^[A-Za-z0-9-]+$/;
const sessionId = () => z.string({ error: "bad sessionId" }).regex(SESSION_ID_RE, { error: "bad sessionId" });

// ---- what the shared preambles read ----------------------------------------

/** column-update/-delete/-reorder: which column. */
export const ColumnRef = body({ columnId: text() });
/** card-*: which card. */
export const CardRef = body({ cardId: text() });
/** Session actions (rename, sprite, focus, prompt, …): which session. */
export const SessionRef = body({ sessionId: sessionId() });
/** Actions that read nothing beyond what their preamble already did. */
export const NoFields = body({});

/** How a card write or a crew note is signed (see resolveSigner in
 *  src/server.ts). Lenient on purpose: which convention wins, and whether a
 *  sessionId or crew id is well formed, is resolveSigner's call — refusing a
 *  bad sessionId here would beat an `as: "assignee"` that outranks it. */
export const Signature = body({
  as: z.literal("assignee").optional().catch(undefined),
  sessionId: maybeText(),
  crew: maybeText(),
  author: trimmed(),
  /** Which card `as: "assignee"` means, for a caller not already on one. */
  cardId: maybeText(),
});
export type Signature = z.output<typeof Signature>;

// ---- per action -------------------------------------------------------------

export const PickFolderBody = body({ cwd: maybeText() });

const FOLDER_AND_TASK = "folder and task are required";
export const SpawnBody = body({
  cwd: required(FOLDER_AND_TASK),
  // kept as typed; only its blankness is judged
  text: z.string({ error: FOLDER_AND_TASK }).refine((t) => t.trim() !== "", { error: FOLDER_AND_TASK }),
  cardId: maybeTrimmed(),
  force: flag(),
  model: oneOf(ALLOWED_MODELS),
  // "default" is the old name of "manual" — mapped rather than dropped, since
  // a spawn with no mode from outside the browser falls back to auto.
  permissionMode: z.preprocess((v) => (v === "default" ? "manual" : v), oneOf(ALLOWED_PERMISSION_MODES)),
  // Blank means "none". The worktree name is slugged inside createWorktree,
  // so it is passed on as typed.
  worktree: maybeTrimmed(),
  branch: maybeTrimmed(),
  persona: maybeTrimmed(),
});

export const ColumnAddBody = body({ name: text() });

export const ColumnUpdateBody = body({
  name: maybeText(),
  instruction: maybeText(),
  stage: z.enum(STAGES as [Stage, ...Stage[]], { error: `stage must be one of ${STAGES.join(", ")} or null` })
    .nullable().optional(),
}).refine((b) => b.name !== undefined || b.instruction !== undefined || b.stage !== undefined, {
  error: "name, instruction or stage is required",
});

const TO_INDEX = "toIndex must be an integer";
export const ColumnReorderBody = body({
  // Number.isInteger rather than .int(): .int() also caps at the safe range
  toIndex: z.number({ error: TO_INDEX }).refine(Number.isInteger, { error: TO_INDEX }),
});

// column-restore / card-restore hand back what was deleted, so it goes
// through the same repair a board read does.
export const ColumnRestoreBody = body({
  column: sanitized<Column>(sanitizeColumn, "a valid column is required"),
  index: z.number().catch(0),
  cards: z.array(z.unknown()).catch([]).transform((cs) => cs.map(sanitizeCard).filter(Boolean) as Card[]),
});

export const CardRestoreBody = body({
  card: sanitized<Card>(sanitizeCard, "a valid card is required"),
  index: z.number().catch(0),
});

// column-archive: optionally only cards quiet for this many days, and
// optionally only these cards (the ones a repo-filtered view shows).
export const ColumnArchiveBody = body({
  olderThanDays: z.number().positive().optional().catch(undefined),
  cardIds: z.array(z.string()).optional().catch(undefined),
});

// card-unarchive: one card, or a batch (an archive's UNDO) with cardIds.
export const CardUnarchiveBody = body({
  cardId: text(),
  cardIds: z.array(z.string()).optional().catch(undefined),
});

export const CardAddBody = body({
  columnId: text(),
  title: z.string({ error: "title is required" }).trim().min(1, { error: "title is required" }),
  description: text(),
  // "scrum" makes the project's scrum master card; anything else is ignored.
  kind: z.literal("scrum").optional().catch(undefined),
  // The project the card is for, as on card-update; a path without a name is dropped.
  repo: maybeTrimmed().optional(),
  repoPath: maybeTrimmed().optional(),
});

export const CommentDeleteBody = body({ commentId: required("commentId is required") });

export const CardMoveBody = Signature.extend({
  // Compared as-is against the column ids and echoed as sent in the "unknown
  // column" error, so it is not coerced to a string.
  toColumnId: z.unknown(),
  // Without one the card is appended to the column.
  toIndex: z.number().refine(Number.isInteger).optional().catch(undefined),
});

// Each field is applied only when present, so renaming a card can't wipe a
// description written by someone else (and vice versa).
export const CardUpdateBody = body({
  // "" or null clears the card's project label
  repo: z.string({ error: "repo must be a string (or null to clear it)" }).nullable().optional(),
  // where that repo lives, kept only alongside a repo name (as on card-add)
  repoPath: maybeTrimmed().optional(),
  // a blank title would leave the card unidentifiable on the board
  title: maybeText()
    .refine((t) => t === undefined || t.trim() !== "", { error: "title cannot be blank" })
    .transform((t) => t?.trim()),
  description: maybeText(),
  // The card's file claim, as paths/globs; [] clears it.
  touches: z.array(
    z.string({ error: "touches must be a list of file paths or globs" }),
    { error: "touches must be a list of file paths or globs" },
  ).optional(),
}).refine((b) => b.title !== undefined || b.description !== undefined || b.touches !== undefined || b.repo !== undefined, {
  error: "title, description, touches or repo is required",
});

// `tip` is the branch tip SHA the human's preview showed; when present, a
// branch that has moved since is refused rather than landed (see mergeWork).
export const CardMergeBody = Signature.extend({ force: flag(), tip: maybeTrimmed() });

// worktree-cleanup: without `remove`, a preview; with it, the worktree paths
// the human confirmed. Anything but a list of strings reads as a preview.
export const WorktreeCleanupBody = body({
  remove: z.array(z.string()).optional().catch(undefined),
});

export const CardCommentBody = Signature.extend({ text: trimmed() });

/** Who pressed SEND TASK; the handler signs the card "You" when blank. */
export const SendTaskBody = body({ author: trimmed() });

export const CardAssignBody = body({
  // null unassigns
  sessionId: sessionId().nullable(),
  force: flag(),
});

export const UploadBody = body({
  name: z.string().catch("image"),
  type: text(),
  dataBase64: required("no image data"),
});

export const CrewNoteBody = Signature.extend({
  text: text(),
  replace: flag(),
});

// absent clears the name; anything but a string would throw in setNameOverride
export const RenameBody = body({ name: z.string({ error: "name must be a string" }).optional() });

const PALETTE_AND_GEAR = "palette and gear are required";
export const SpriteBody = body({
  palette: z.number({ error: PALETTE_AND_GEAR }),
  gear: z.string({ error: PALETTE_AND_GEAR }),
  body: maybeText(),
});

export const PromptBody = body({
  text: z.string({ error: "empty prompt" })
    .refine((t) => t.trim() !== "", { error: "empty prompt" })
    .max(10_000, { error: "prompt too long" }),
});

// ---- the MOOD board (src/lib/mood.ts) ------------------------------------------
// The board's own sanitizer clamps coordinates and widths, so these only
// judge what the handler can't repair.

const moodKind = () => z.enum(MOOD_KINDS as [MoodKind, ...MoodKind[]], { error: `kind must be one of ${MOOD_KINDS.join(", ")}` });
const finite = (message: string) => z.number({ error: message }).refine(Number.isFinite, { error: message });

export const MoodNoteAddBody = body({
  title: z.string({ error: "title is required" }).trim().min(1, { error: "title is required" }),
  x: finite("x and y must be numbers").catch(0),
  y: finite("x and y must be numbers").catch(0),
  kind: moodKind().optional(),
  body: text(),
  w: z.number().optional().catch(undefined),
  cardId: maybeTrimmed(),
  author: trimmed(),
});

export const MoodNoteRef = body({ noteId: required("noteId is required") });

export const MoodNoteUpdateBody = body({
  title: maybeText()
    .refine((t) => t === undefined || t.trim() !== "", { error: "title cannot be blank" })
    .transform((t) => t?.trim()),
  body: maybeText(),
  kind: moodKind().optional(),
  x: finite("x must be a number").optional(),
  y: finite("y must be a number").optional(),
  w: finite("w must be a number").optional(),
  // "" or null unlinks the note from its card
  cardId: z.string().nullable().optional().catch(undefined).transform((c) => (c === "" ? null : c?.trim())),
  // true brings the note to the front
  raise: flag(),
}).refine((b) => [b.title, b.body, b.kind, b.x, b.y, b.w, b.cardId].some((v) => v !== undefined) || b.raise, {
  error: "title, body, kind, x, y, w, cardId or raise is required",
});

// mood-note-restore hands back what was deleted; the board's sanitizer drops
// any link whose other end is gone.
export const MoodNoteRestoreBody = body({
  note: sanitized<MoodNote>(sanitizeNote, "a valid note is required"),
  links: z.array(z.unknown()).catch([]),
});

export const MoodLinkAddBody = body({
  from: required("from and to are required"),
  to: required("from and to are required"),
  label: text(),
});

export const MoodLinkRef = body({ linkId: required("linkId is required") });
export const MoodLinkUpdateBody = body({ label: text() });

// ---- memory-*: the team memory (src/lib/memory.ts) ----------------------------

/** kind and title are judged by remember(), which words the refusal. */
const strings = () => z.array(z.unknown()).catch([]).transform((a) => a.filter((x): x is string => typeof x === "string"));
/** A list refused past `max` items, so a runaway caller gets a 400 rather
 *  than a silent cut. */
const cappedStrings = (max: number, message: string) => strings().refine((a) => a.length <= max, { error: message });
export const MemoryAddBody = body({
  kind: text(),
  title: text(),
  body: text().refine((s) => s.length <= BODY_MAX, { error: `body is over ${BODY_MAX} characters` }),
  tags: cappedStrings(MAX_TAGS, `at most ${MAX_TAGS} tags`),
  links: cappedStrings(MAX_LINKS, `at most ${MAX_LINKS} links`),
  author: trimmed().refine((s) => s.length <= BY_MAX, { error: `author is over ${BY_MAX} characters` }),
});
export const MemoryForgetBody = body({ id: trimmed() });
