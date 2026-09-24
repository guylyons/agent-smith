// The WAITING ON YOU flag (card.ask): the pure ops, loading, the footer line,
// the HUD's oldest-first order, and the card-comment / card-ask-clear actions.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import { readSnapshot } from "../src/server";
import {
  addCard, addComment, assignCard, deleteComment, defaultBoard, setAsk, waitingOnYou,
  sanitizeBoard, cardTaskFooter, type Board,
} from "../src/lib/board";
import { cardName } from "../src/ui/TheLine";
import { waitingLabel, newAsks } from "../src/ui/WaitingOnYou";
import { deskAsking } from "../src/ui/Crew";

function withComment(): Board {
  const b = addCard(defaultBoard(), "backlog", "t");
  return addComment(b, b.cards[0]!.id, "RIPLEY", "A or B?");
}

// ---- pure ops -------------------------------------------------------------

test("setAsk flags a comment with its author and time; null clears it", () => {
  let b = withComment();
  const card = b.cards[0]!;
  const m = card.comments![0]!;
  b = setAsk(b, card.id, m.id);
  expect(b.cards[0]!.ask).toEqual({ commentId: m.id, by: "RIPLEY", at: m.at });
  b = setAsk(b, card.id, null);
  expect("ask" in b.cards[0]!).toBe(false);
});

test("setAsk on a comment the card doesn't have changes nothing", () => {
  const b = withComment();
  expect(setAsk(b, b.cards[0]!.id, "cmt_nope")).toEqual(b);
});

test("deleting the asking comment clears the flag", () => {
  let b = withComment();
  const id = b.cards[0]!.id;
  const cid = b.cards[0]!.comments![0]!.id;
  b = deleteComment(setAsk(b, id, cid), id, cid);
  expect(b.cards[0]!.ask).toBeUndefined();
});

test("waitingOnYou lists only flagged cards, oldest question first", () => {
  const cards = [
    { id: "a", ask: { commentId: "c1", by: "X", at: 300 } },
    { id: "b" },
    { id: "c", ask: { commentId: "c2", by: "Y", at: 100 } },
    { id: "d", ask: { commentId: "c3", by: "Z", at: 200 } },
  ];
  expect(waitingOnYou(cards).map((k) => k.id)).toEqual(["c", "d", "a"]);
  const none: { id: string; ask?: undefined }[] = [{ id: "x" }];
  expect(waitingOnYou(none)).toEqual([]);
});

test("the HUD label counts, and is empty at zero", () => {
  expect(waitingLabel(0)).toBe("");
  expect(waitingLabel(1)).toBe("1 waiting on you");
  expect(waitingLabel(3)).toBe("3 waiting on you");
});

// ---- loading --------------------------------------------------------------

test("an old board without the field loads unchanged", () => {
  const raw = {
    columns: defaultBoard().columns,
    cards: [{ id: "card_1", title: "old", columnId: "backlog", num: 1, comments: [{ id: "cmt_1", author: "A", text: "hi", at: 1 }] }],
    nextNum: 2,
  };
  const b = sanitizeBoard(raw);
  expect(b.cards[0]).toEqual(raw.cards[0]!);
  expect("ask" in b.cards[0]!).toBe(false);
});

test("a saved ask survives load; a broken one or one naming a missing comment is dropped", () => {
  const card = (ask: unknown) => ({
    id: "card_1", title: "t", columnId: "backlog", ask,
    comments: [{ id: "cmt_1", author: "A", text: "hi", at: 1 }],
  });
  const load = (ask: unknown) => sanitizeBoard({ columns: defaultBoard().columns, cards: [card(ask)] }).cards[0]!.ask;
  expect(load({ commentId: "cmt_1", by: "A", at: 5 })).toEqual({ commentId: "cmt_1", by: "A", at: 5 });
  expect(load({ commentId: "cmt_gone", by: "A", at: 5 })).toBeUndefined();
  expect(load({ commentId: "cmt_1", by: "A" })).toBeUndefined();
  expect(load("yes")).toBeUndefined();
});

// ---- footer and card label -----------------------------------------------

test("the footer says when to use ask", () => {
  const b = addCard(defaultBoard(), "backlog", "t");
  const footer = cardTaskFooter(b, b.cards[0]!.id, "http://localhost:4173", "RIPLEY", { crew: "ripley-3f2a" });
  const step2 = footer.slice(footer.indexOf("STEP 2"), footer.indexOf("STEP 3"));
  expect(step2).toContain('"ask":true');
  expect(step2).toContain("not a permission");
});

test("cardName says the card is waiting on you", () => {
  const ask = { commentId: "c", by: "RIPLEY", at: 1 };
  expect(cardName({ title: "T", assignee: null, ask }, "none", 0, 1)).toContain("waiting on you");
  expect(cardName({ title: "T", assignee: null }, "none", 0, 1)).not.toContain("waiting");
});

// ---- the actions ----------------------------------------------------------

const dir = fixtureDir("ask-test");
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
  writeFileSync(join(dir, `${WORKER}.json`), valid({ sessionId: WORKER, name: "RIPLEY", crew: RIPLEY }));
  writeFileSync(join(dir, `${WORKER2}.json`), valid({ sessionId: WORKER2, name: "BISHOP", crew: BISHOP }));
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

test("card-comment with ask: true flags the card with that comment", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "progress" });
    expect(card().ask).toBeUndefined();
    const r = await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "A or B?", ask: true });
    expect(r.body.ok).toBe(true);
    const m = card().comments!.at(-1)!;
    expect(card().ask).toEqual({ commentId: m.id, by: m.author, at: m.at });
    expect(r.body.commentId).toBe(m.id);
  } finally { server.stop(true); }
});

test("another agent comment leaves the flag; the human's comment clears it", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "A or B?", ask: true });
    const asked = card().ask;
    // the asker again, another agent by session, and an agent signing with just the human's byline plus a crew
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "still waiting" });
    await post("/action/card-comment", { cardId, sessionId: WORKER2, text: "+1, need this too" });
    await post("/action/card-comment", { cardId, crew: BISHOP.id, author: "You", text: "sneaky" });
    expect(card().ask).toEqual(asked!);
    // the human replies
    await post("/action/card-comment", { cardId, author: "You", text: "B" });
    expect(card().ask).toBeUndefined();
  } finally { server.stop(true); }
});

test("the human can't raise an ask on their own comment", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    await post("/action/card-comment", { cardId, author: "You", text: "hm", ask: true });
    expect(card().ask).toBeUndefined();
  } finally { server.stop(true); }
});

test("card-ask-clear: the human or the asker may clear by hand; another agent may not", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    // nothing to clear is fine
    expect((await post("/action/card-ask-clear", { cardId, author: "You" })).body.ok).toBe(true);
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "A or B?", ask: true });
    expect((await post("/action/card-ask-clear", { cardId, sessionId: WORKER2 })).status).toBe(403);
    expect(card().ask).toBeDefined();
    expect((await post("/action/card-ask-clear", { cardId, author: "You" })).body.ok).toBe(true);
    expect(card().ask).toBeUndefined();
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "C or D?", ask: true });
    expect((await post("/action/card-ask-clear", { cardId, as: "assignee", crew: RIPLEY.id })).body.ok).toBe(true);
    expect(card().ask).toBeUndefined();
  } finally { server.stop(true); }
});

test("a crew taken off the card gets a 409 for an ask or a clear", async () => {
  const { server, post, cardId, card } = await setup();
  try {
    await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "A or B?", ask: true });
    const asked = card().ask;
    await post("/action/card-assign", { cardId, sessionId: WORKER2 });
    const c = await post("/action/card-comment", { cardId, as: "assignee", crew: RIPLEY.id, text: "late", ask: true });
    expect(c.status).toBe(409);
    expect(c.body.error).toContain("no longer assigned");
    const x = await post("/action/card-ask-clear", { cardId, sessionId: WORKER });
    expect(x.status).toBe(409);
    expect(card().ask).toEqual(asked!);
  } finally { server.stop(true); }
});

test("newAsks finds only questions the last board didn't have", () => {
  const ask = (id: string) => ({ commentId: id, by: "X", at: 1 });
  const cards = [{ title: "a", ask: ask("c1") }, { title: "b", ask: ask("c2") }, { title: "c" }];
  expect(newAsks(new Set(["c1"]), cards).map((k) => k.title)).toEqual(["b"]);
});

test("a desk shows WAITING ON YOU when a card it holds has an open ask", () => {
  let b = withComment();
  const id = b.cards[0]!.id;
  b = assignCard(b, id, { id: WORKER, name: "RIPLEY", crew: RIPLEY.id });
  expect(deskAsking(b, { sessionId: WORKER, crew: RIPLEY })).toBe(false);
  b = setAsk(b, id, b.cards[0]!.comments![0]!.id);
  expect(deskAsking(b, { sessionId: WORKER, crew: RIPLEY })).toBe(true);
  // found by crew after a /clear gave it a new session id
  expect(deskAsking(b, { sessionId: WORKER2, crew: RIPLEY })).toBe(true);
  expect(deskAsking(b, { sessionId: WORKER2, crew: BISHOP })).toBe(false);
});
