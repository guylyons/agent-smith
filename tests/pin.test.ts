// Pinning one comment per card as its handoff note (card.pinnedCommentId):
// the pure ops, loading, the worker footer, and the card-comment / card-pin
// actions with who may pin and unpin.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import { readSnapshot } from "../src/server";
import {
  addCard, addComment, deleteComment, defaultBoard, pinComment, pinnedComment,
  sanitizeBoard, cardTaskFooter, type Board,
} from "../src/lib/board";
import { cardName } from "../src/ui/TheLine";

function withComments(): Board {
  let b = addCard(defaultBoard(), "backlog", "t");
  const id = b.cards[0]!.id;
  b = addComment(b, id, "RIPLEY", "progress");
  return addComment(b, id, "RIPLEY", "final");
}

// ---- pure ops -------------------------------------------------------------

test("pinComment pins one comment, a new pin replaces it, null clears it", () => {
  let b = withComments();
  const card = b.cards[0]!;
  const [first, second] = card.comments!;
  b = pinComment(b, card.id, first!.id);
  expect(b.cards[0]!.pinnedCommentId).toBe(first!.id);
  b = pinComment(b, card.id, second!.id);
  expect(b.cards[0]!.pinnedCommentId).toBe(second!.id);
  expect(pinnedComment(b.cards[0]!)?.text).toBe("final");
  b = pinComment(b, card.id, null);
  expect("pinnedCommentId" in b.cards[0]!).toBe(false);
});

test("pinning a comment the card doesn't have changes nothing", () => {
  const b = withComments();
  expect(pinComment(b, b.cards[0]!.id, "cmt_nope")).toEqual(b);
});

test("deleting the pinned comment clears the pin", () => {
  let b = withComments();
  const id = b.cards[0]!.id;
  const cid = b.cards[0]!.comments![1]!.id;
  b = deleteComment(pinComment(b, id, cid), id, cid);
  expect(b.cards[0]!.pinnedCommentId).toBeUndefined();
});

// ---- loading --------------------------------------------------------------

test("a board without the field loads unchanged", () => {
  const raw = {
    columns: defaultBoard().columns,
    cards: [{ id: "card_1", title: "old", columnId: "backlog", num: 1, comments: [{ id: "cmt_1", author: "A", text: "hi", at: 1 }] }],
    nextNum: 2,
  };
  const b = sanitizeBoard(raw);
  expect(b.cards[0]).toEqual(raw.cards[0]!);
  expect("pinnedCommentId" in b.cards[0]!).toBe(false);
});

test("a saved pin survives load; one naming a missing comment is dropped", () => {
  const card = (pinnedCommentId: string) => ({
    id: "card_1", title: "t", columnId: "backlog", pinnedCommentId,
    comments: [{ id: "cmt_1", author: "A", text: "hi", at: 1 }],
  });
  expect(sanitizeBoard({ columns: defaultBoard().columns, cards: [card("cmt_1")] }).cards[0]!.pinnedCommentId).toBe("cmt_1");
  expect(sanitizeBoard({ columns: defaultBoard().columns, cards: [card("cmt_gone")] }).cards[0]!.pinnedCommentId).toBeUndefined();
});

// ---- footer and card label -----------------------------------------------

test("the footer's final step asks for the final comment to be pinned", () => {
  const b = addCard(defaultBoard(), "backlog", "t");
  const id = b.cards[0]!.id;
  const footer = cardTaskFooter(b, id, "http://localhost:4173", "RIPLEY", { crew: "ripley-3f2a" });
  const step3 = footer.slice(footer.indexOf("STEP 3"));
  expect(step3).toContain('"pin":true');
  expect(step3).toContain(`curl -s -X POST http://localhost:4173/action/card-comment -H 'content-type: application/json' -d '{"cardId":"${id}","as":"assignee","crew":"ripley-3f2a","text":`);
  // the pin comes before the move to review
  expect(step3.indexOf('"pin":true')).toBeLessThan(step3.indexOf("Then move the card"));
  // STEP 1's comment is not pinned
  expect(footer.slice(0, footer.indexOf("STEP 2"))).not.toContain('"pin"');
});

test("cardName says a handoff note is pinned", () => {
  const card = { title: "T", assignee: null, pinnedCommentId: "cmt_1" };
  expect(cardName(card, "none", 0, 1)).toContain("handoff note pinned");
  expect(cardName({ title: "T", assignee: null }, "none", 0, 1)).not.toContain("pinned");
});

// ---- the actions ----------------------------------------------------------

const dir = fixtureDir("pin-test");
const WORKER = "502d0e8c-8790-4804-b767-0549edfc959c";
const WORKER2 = "7777aaaa-1111-4222-8333-444455556666";
const RIPLEY = { id: "ripley-3f2a", name: "RIPLEY" };
const BISHOP = { id: "bishop-9c1d", name: "BISHOP" };
const valid = (o: object) => JSON.stringify({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "idle",
  doing: "x", cwd: "/", branch: "b", updatedAt: 9_999_999_999_999, ...o,
});

async function setup() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, crew: RIPLEY }));
  writeFileSync(join(dir, `${WORKER2}.json`), valid({ sessionId: WORKER2, crew: BISHOP }));
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { deliver: async () => ({ ok: true }), deliverFresh: async () => ({ ok: true }) });
  const base = `http://localhost:${server.port}`;
  const post = async (path: string, body: object) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const { body: { cardId } } = await post("/action/card-add", { columnId: "backlog", title: "Fix bug" });
  await post("/action/card-assign", { cardId, sessionId: WORKER });
  const card = () => readSnapshot(dir, Date.now()).board.cards.find((k) => k.id === cardId)!;
  return { server, post, cardId, card };
}

test("card-comment with pin: true pins the new comment; a later one replaces it", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "progress" });
    expect(card().pinnedCommentId).toBeUndefined();
    const a = await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "first handoff", pin: true });
    expect(a.body.ok).toBe(true);
    expect(pinnedComment(card())?.text).toBe("first handoff");
    expect(a.body.commentId).toBe(card().pinnedCommentId);
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "second handoff", pin: true });
    expect(pinnedComment(card())?.text).toBe("second handoff");
  } finally { server.stop(true); }
});

test("card-pin: the author and the human may pin and unpin; another agent may not", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "handoff" });
    const commentId = card().comments!.at(-1)!.id;
    // another agent, signed by its own session
    const other = await post("/action/card-pin", { cardId, sessionId: WORKER2, commentId });
    expect(other.status).toBe(403);
    expect(card().pinnedCommentId).toBeUndefined();
    // the author pins it
    expect((await post("/action/card-pin", { cardId, as: "assignee", crew: RIPLEY.id, commentId })).body.ok).toBe(true);
    expect(card().pinnedCommentId).toBe(commentId);
    // the other agent can't unpin it either
    expect((await post("/action/card-pin", { cardId, sessionId: WORKER2, commentId, pin: false })).status).toBe(403);
    expect(card().pinnedCommentId).toBe(commentId);
    // the human can
    expect((await post("/action/card-pin", { cardId, author: "You", commentId, pin: false })).body.ok).toBe(true);
    expect(card().pinnedCommentId).toBeUndefined();
    // and pin anyone's comment
    expect((await post("/action/card-pin", { cardId, author: "You", commentId })).body.ok).toBe(true);
    expect(card().pinnedCommentId).toBe(commentId);
  } finally { server.stop(true); }
});

test("card-pin: unpinning a comment that isn't the pinned one leaves the pin alone", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    await post("/action/card-comment", { cardId, author: "You", text: "a" });
    await post("/action/card-comment", { cardId, author: "You", text: "b", pin: true });
    const [a, b] = card().comments!;
    expect((await post("/action/card-pin", { cardId, author: "You", commentId: a!.id, pin: false })).body.ok).toBe(true);
    expect(card().pinnedCommentId).toBe(b!.id);
  } finally { server.stop(true); }
});

test("card-pin on an unknown comment is a 404", async () => {
  const { server, post, cardId } = await setup();
  try {
    expect((await post("/action/card-pin", { cardId, author: "You", commentId: "cmt_nope" })).status).toBe(404);
  } finally { server.stop(true); }
});

test("a crew taken off the card can't pin, by card-comment or card-pin", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "mine" });
    const commentId = card().comments!.at(-1)!.id;
    await post("/action/card-assign", { cardId, sessionId: WORKER2 });
    const c = await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "late", pin: true });
    expect(c.status).toBe(409);
    expect(c.body.error).toContain("no longer assigned");
    const p = await post("/action/card-pin", { cardId, as: "assignee", crew: RIPLEY.id, commentId });
    expect(p.status).toBe(409);
    // signed by its own session instead: still refused (card.removedCrews)
    const s = await post("/action/card-pin", { cardId, sessionId: WORKER, commentId });
    expect(s.status).toBe(409);
    expect(card().pinnedCommentId).toBeUndefined();
  } finally { server.stop(true); }
});
