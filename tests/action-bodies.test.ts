// tests/action-bodies.test.ts — the zod schemas that read /action/* bodies.
// They replaced inline typeof checks one for one, so these pin the old rules:
// a field of the wrong type falls back to the same default it always did, and
// a refused body carries the same error text, in the same order.
import { test, expect } from "bun:test";
import type { z } from "zod";
import {
  parseBody, CardRef, ColumnRef, SessionRef, Signature,
  PickFolderBody, SpawnBody, ColumnAddBody, ColumnUpdateBody, ColumnReorderBody,
  ColumnRestoreBody, CardRestoreBody, CardAddBody, CommentDeleteBody, CardMoveBody,
  CardUpdateBody, CardMergeBody, CardCommentBody, SendTaskBody, CardAssignBody,
  UploadBody, CrewNoteBody, RenameBody, SpriteBody, PromptBody,
} from "../src/lib/actionBodies";

const ok = <S extends z.ZodType>(schema: S, body: unknown): z.output<S> => {
  const r = parseBody(schema, body);
  if ("error" in r) throw new Error(`expected a parse, got: ${r.error}`);
  return r.data;
};
const err = (schema: z.ZodType, body: unknown): string => {
  const r = parseBody(schema, body);
  if (!("error" in r)) throw new Error(`expected an error, got: ${JSON.stringify(r.data)}`);
  return r.error;
};

test("a body that is not a JSON object is a bad body, for every schema", () => {
  for (const body of [null, [], 5, "s", true]) {
    expect(err(CardRef, body)).toBe("bad body");
    expect(err(SpawnBody, body)).toBe("bad body");
    expect(err(CardMoveBody, body)).toBe("bad body"); // an .extend()ed Signature
    expect(err(ColumnUpdateBody, body)).toBe("bad body"); // a .refine()d body
  }
});

test("refs: a non-string id reads as the empty string", () => {
  expect(ok(CardRef, { cardId: 5 })).toEqual({ cardId: "" });
  expect(ok(ColumnRef, {})).toEqual({ columnId: "" });
  expect(ok(CardRef, { cardId: "card_1" })).toEqual({ cardId: "card_1" });
});

test("SessionRef: sessionId must be a single safe path segment", () => {
  expect(ok(SessionRef, { sessionId: "abc-123" })).toEqual({ sessionId: "abc-123" });
  for (const sessionId of [undefined, 5, "", "../x", "a b", null]) {
    expect(err(SessionRef, { sessionId })).toBe("bad sessionId");
  }
});

test("Signature: lenient, so resolveSigner still decides which convention wins", () => {
  expect(ok(Signature, {})).toEqual({ as: undefined, sessionId: undefined, crew: undefined, author: "", cardId: undefined });
  expect(ok(Signature, { as: "someone", sessionId: 5, crew: 5, author: 5, cardId: 5 }))
    .toEqual({ as: undefined, sessionId: undefined, crew: undefined, author: "", cardId: undefined });
  // A malformed sessionId is passed through: rejecting it here would beat an
  // `as: "assignee"` that is meant to take precedence over it.
  expect(ok(Signature, { as: "assignee", sessionId: "../x", author: "  Bo  " }))
    .toEqual({ as: "assignee", sessionId: "../x", crew: undefined, author: "Bo", cardId: undefined });
});

test("PickFolderBody: cwd only when it is a string", () => {
  expect(ok(PickFolderBody, { cwd: "/tmp" }).cwd).toBe("/tmp");
  expect(ok(PickFolderBody, { cwd: 5 }).cwd).toBeUndefined();
});

test("SpawnBody: folder and task required; optional fields trimmed or dropped", () => {
  const b = ok(SpawnBody, {
    cwd: "/w", text: " do it ", cardId: " c1 ", force: true, model: "opus", permissionMode: "plan",
    worktree: " wt ", branch: " br ", persona: " backend-dev ",
  });
  expect(b).toEqual({
    cwd: "/w", text: " do it ", cardId: "c1", force: true, model: "opus", permissionMode: "plan",
    worktree: "wt", branch: "br", persona: "backend-dev",
  });
  const lean = ok(SpawnBody, { cwd: "/w", text: "t", cardId: "  ", force: "yes", model: "gpt", permissionMode: 1, worktree: 5, branch: "", persona: null });
  expect(lean).toEqual({
    cwd: "/w", text: "t", cardId: undefined, force: false, model: undefined, permissionMode: undefined,
    worktree: undefined, branch: undefined, persona: undefined,
  });
  // "default" is gone from the CLI's list; it means the prompt-for-everything
  // mode, now called "manual" — mapped, not dropped (a dropped mode on an API
  // spawn falls back to auto).
  expect(ok(SpawnBody, { cwd: "/w", text: "t", permissionMode: "default" }).permissionMode).toBe("manual");
  expect(ok(SpawnBody, { cwd: "/w", text: "t", permissionMode: "manual" }).permissionMode).toBe("manual");
  expect(ok(SpawnBody, { cwd: "/w", text: "t", permissionMode: "dontAsk" }).permissionMode).toBeUndefined();
  for (const body of [{ text: "t" }, { cwd: "", text: "t" }, { cwd: "/w" }, { cwd: "/w", text: "   " }, { cwd: 5, text: 5 }]) {
    expect(err(SpawnBody, body)).toBe("folder and task are required");
  }
});

test("ColumnAddBody: a missing name is the empty string", () => {
  expect(ok(ColumnAddBody, {})).toEqual({ name: "" });
  expect(ok(ColumnAddBody, { name: "QA" })).toEqual({ name: "QA" });
});

test("ColumnUpdateBody: one field required, stage checked against STAGES", () => {
  expect(err(ColumnUpdateBody, {})).toBe("name, instruction or stage is required");
  expect(err(ColumnUpdateBody, { name: 5, instruction: false })).toBe("name, instruction or stage is required");
  expect(err(ColumnUpdateBody, { stage: "nope" })).toBe("stage must be one of todo, doing, review, done or null");
  expect(err(ColumnUpdateBody, { name: "x", stage: 5 })).toBe("stage must be one of todo, doing, review, done or null");
  expect(ok(ColumnUpdateBody, { name: "" })).toEqual({ name: "", instruction: undefined, stage: undefined });
  expect(ok(ColumnUpdateBody, { stage: null })).toEqual({ name: undefined, instruction: undefined, stage: null });
  expect(ok(ColumnUpdateBody, { instruction: "i", stage: "review" })).toEqual({ name: undefined, instruction: "i", stage: "review" });
});

test("ColumnReorderBody: toIndex must be an integer", () => {
  expect(ok(ColumnReorderBody, { toIndex: 2 })).toEqual({ toIndex: 2 });
  expect(ok(ColumnReorderBody, { toIndex: 1e20 })).toEqual({ toIndex: 1e20 });
  for (const toIndex of [undefined, "2", 1.5, null]) {
    expect(err(ColumnReorderBody, { toIndex })).toBe("toIndex must be an integer");
  }
});

test("ColumnRestoreBody / CardRestoreBody: sanitized, index defaults to 0", () => {
  const column = { id: "c9", name: "Nine", instruction: "" };
  const card = { id: "k1", title: "T", columnId: "c9" };
  expect(ok(ColumnRestoreBody, { column, index: 3, cards: [card, { junk: true }] }))
    .toEqual({ column, index: 3, cards: [card] });
  expect(ok(ColumnRestoreBody, { column, index: "3", cards: "nope" })).toEqual({ column, index: 0, cards: [] });
  expect(err(ColumnRestoreBody, {})).toBe("a valid column is required");
  expect(err(ColumnRestoreBody, { column: { id: 5 } })).toBe("a valid column is required");
  expect(ok(CardRestoreBody, { card })).toEqual({ card, index: 0 });
  expect(err(CardRestoreBody, { card: { id: "k1" }, index: 1 })).toBe("a valid card is required");
});

test("CardAddBody: title trimmed and required", () => {
  expect(ok(CardAddBody, { columnId: "c1", title: "  T  ", description: "d" })).toEqual({ columnId: "c1", title: "T", description: "d" });
  expect(ok(CardAddBody, { title: "T", columnId: 5, description: 5 })).toEqual({ columnId: "", title: "T", description: "" });
  for (const title of [undefined, "", "   ", 5]) expect(err(CardAddBody, { columnId: "c1", title })).toBe("title is required");
});

test("CommentDeleteBody: commentId required", () => {
  expect(ok(CommentDeleteBody, { commentId: "cmt_1" })).toEqual({ commentId: "cmt_1" });
  for (const commentId of [undefined, "", 5]) expect(err(CommentDeleteBody, { commentId })).toBe("commentId is required");
});

test("CardMoveBody: toColumnId opaque, toIndex only when an integer", () => {
  const b = ok(CardMoveBody, { toColumnId: "review", toIndex: 1, author: "Al" });
  expect(b.toColumnId).toBe("review");
  expect(b.toIndex).toBe(1);
  expect(b.author).toBe("Al");
  // compared by identity and echoed in the error as sent, so it is not coerced
  expect(ok(CardMoveBody, { toColumnId: 5 }).toColumnId).toBe(5);
  for (const toIndex of [1.5, "1", null]) expect(ok(CardMoveBody, { toColumnId: "x", toIndex }).toIndex).toBeUndefined();
});

test("CardUpdateBody: presence per field, then repo, blank title, touches — in that order", () => {
  expect(err(CardUpdateBody, {})).toBe("title, description, touches or repo is required");
  expect(err(CardUpdateBody, { title: 5, description: 5 })).toBe("title, description, touches or repo is required");
  expect(err(CardUpdateBody, { repo: 5, title: " ", touches: 5 })).toBe("repo must be a string (or null to clear it)");
  expect(err(CardUpdateBody, { title: " ", touches: 5 })).toBe("title cannot be blank");
  expect(err(CardUpdateBody, { touches: 5 })).toBe("touches must be a list of file paths or globs");
  expect(err(CardUpdateBody, { touches: ["a", 1] })).toBe("touches must be a list of file paths or globs");
  expect(ok(CardUpdateBody, { title: " New ", description: "", touches: [], repo: null }))
    .toEqual({ title: "New", description: "", touches: [], repo: null });
  expect(ok(CardUpdateBody, { repo: "r" })).toEqual({ title: undefined, description: undefined, touches: undefined, repo: "r" });
});

test("CardMergeBody / CardCommentBody / SendTaskBody", () => {
  expect(ok(CardMergeBody, { force: true, author: "You" })).toMatchObject({ force: true, author: "You" });
  expect(ok(CardMergeBody, { force: 1 }).force).toBe(false);
  expect(ok(CardCommentBody, { text: "  hi  ", as: "assignee" })).toMatchObject({ text: "hi", as: "assignee" });
  expect(ok(CardCommentBody, { text: 5 }).text).toBe("");
  expect(ok(SendTaskBody, { author: "  Me " })).toEqual({ author: "Me" });
  expect(ok(SendTaskBody, { author: 5 })).toEqual({ author: "" });
});

test("CardAssignBody: null unassigns, anything else must be a session id", () => {
  expect(ok(CardAssignBody, { sessionId: null })).toEqual({ sessionId: null, force: false, selfAssign: false });
  expect(ok(CardAssignBody, { sessionId: "abc-1", force: true })).toEqual({ sessionId: "abc-1", force: true, selfAssign: false });
  expect(ok(CardAssignBody, { sessionId: "abc-1", selfAssign: true }).selfAssign).toBe(true);
  for (const sessionId of [undefined, 5, "../x", ""]) expect(err(CardAssignBody, { sessionId })).toBe("bad sessionId");
});

test("UploadBody: data required, name defaults to image", () => {
  expect(ok(UploadBody, { dataBase64: "AA==" })).toEqual({ name: "image", type: "", dataBase64: "AA==" });
  expect(ok(UploadBody, { dataBase64: "AA==", name: "a.png", type: "image/png" })).toEqual({ name: "a.png", type: "image/png", dataBase64: "AA==" });
  for (const dataBase64 of [undefined, "", 5]) expect(err(UploadBody, { dataBase64 })).toBe("no image data");
});

test("CrewNoteBody: signature plus text and replace", () => {
  expect(ok(CrewNoteBody, { crew: "bishop-1", text: "n", replace: true })).toMatchObject({ crew: "bishop-1", text: "n", replace: true });
  expect(ok(CrewNoteBody, { text: 5, replace: "yes" })).toMatchObject({ text: "", replace: false });
});

test("RenameBody: a name is a string, or absent to clear", () => {
  expect(ok(RenameBody, { name: "Zed" })).toEqual({ name: "Zed" });
  expect(ok(RenameBody, {})).toEqual({ name: undefined });
  for (const name of [null, 5]) expect(err(RenameBody, { name })).toBe("name must be a string");
});

test("SpriteBody: palette and gear required, body optional", () => {
  expect(ok(SpriteBody, { palette: 2, gear: "hat", body: "b" })).toEqual({ palette: 2, gear: "hat", body: "b" });
  expect(ok(SpriteBody, { palette: 2, gear: "hat", body: 5 })).toEqual({ palette: 2, gear: "hat", body: undefined });
  for (const body of [{ gear: "hat" }, { palette: "2", gear: "hat" }, { palette: 2 }]) {
    expect(err(SpriteBody, body)).toBe("palette and gear are required");
  }
});

test("PromptBody: non-empty, at most 10,000 characters", () => {
  expect(ok(PromptBody, { text: " hi " })).toEqual({ text: " hi " });
  for (const text of [undefined, 5, "", "   "]) expect(err(PromptBody, { text })).toBe("empty prompt");
  expect(err(PromptBody, { text: " ".repeat(10_001) })).toBe("empty prompt");
  expect(err(PromptBody, { text: "x".repeat(10_001) })).toBe("prompt too long");
  expect(ok(PromptBody, { text: "x".repeat(10_000) }).text).toHaveLength(10_000);
});
