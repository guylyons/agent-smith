// GET /card?id=: one card plus the column list, so a worker re-reading its card
// over curl doesn't have to pull the whole board (hundreds of KB on a busy one).
import { test, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { fixtureDir } from "./fixtures";
import { addCard, addComment, defaultBoard, setCardDescription, writeBoard, cardView, type Board } from "../src/lib/board";

function twoCards(): Board {
  let b = addCard(defaultBoard(), "backlog", "mine");
  b = setCardDescription(b, b.cards[0]!.id, "the brief");
  b = addCard(b, "backlog", "someone else's");
  return addComment(b, b.cards[0]!.id, "DALLAS", "a note");
}

test("cardView is the card and the columns, no other cards", () => {
  const b = twoCards();
  const view = cardView(b, b.cards[0]!.id)!;
  expect(view.card).toEqual(b.cards[0]!);
  expect(view.columns).toEqual(b.columns);
  expect(JSON.stringify(view)).not.toContain("someone else's");
});

test("cardView on an unknown id is undefined", () => {
  expect(cardView(twoCards(), "card_nope")).toBeUndefined();
});

const dir = fixtureDir("card-endpoint-test");

async function withServer(board: Board, fn: (base: string) => Promise<void>) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  writeBoard(dir, board);
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  try {
    await fn(`http://localhost:${server.port}`);
  } finally {
    server.stop(true);
  }
}

test("GET /card returns only that card, its comments, and every column", async () => {
  const b = twoCards();
  const id = b.cards[0]!.id;
  await withServer(b, async (base) => {
    const res = await fetch(`${base}/card?id=${id}`);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.card.id).toBe(id);
    expect(out.card.description).toBe("the brief");
    expect(out.card.comments.map((c: { text: string }) => c.text)).toEqual(["a note"]);
    expect(out.columns.map((c: { id: string }) => c.id)).toEqual(b.columns.map((c) => c.id));
    expect(out.columns[0]).toHaveProperty("instruction");
    expect(out).not.toHaveProperty("board");
    expect(JSON.stringify(out)).not.toContain("someone else's");
  });
});

test("GET /card on an unknown or missing id is a 404 JSON error", async () => {
  await withServer(twoCards(), async (base) => {
    for (const q of ["?id=card_nope", ""]) {
      const res = await fetch(`${base}/card${q}`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toContain("unknown card");
    }
  });
});
