// tests/optimistic-edit.test.tsx — a board edit the server refuses is undone on
// screen (card #111). The server pushes nothing after a refusal, so without the
// undo a refused drag left the card in the wrong column.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { optimisticEdit } from "../src/ui/optimistic";
import { TheLine } from "../src/ui/TheLine";
import { defaultBoard, moveCard, type Board, type Card } from "../src/lib/board";

function serverBoard(): Board {
  const b = defaultBoard();
  const card = { id: "c1", title: "Stale card", columnId: b.columns[0]!.id, comments: [] } as unknown as Card;
  return { ...b, cards: [card] };
}

/** The board state TheLine holds, driven the way its mutate drives it. */
function holder(initial: Board) {
  let board = initial;
  return { get: () => board, set: (next: (prev: Board) => Board) => { board = next(board); } };
}

const render = (board: Board) =>
  renderToStaticMarkup(<TheLine board={board} agents={[]} lineRows={10} onSpawnForCard={() => {}} />);

/** Which column's markup the card sits in. */
function columnOf(html: string, cardId: string): string | undefined {
  const at = html.indexOf(`data-card-id="${cardId}"`);
  if (at < 0) return undefined;
  const cols = [...html.slice(0, at).matchAll(/<input class="col-name pix" placeholder="Name…" value="([^"]*)"/g)];
  return cols.at(-1)?.[1];
}

test("a refused move leaves the rendered board matching the server", async () => {
  const server = serverBoard();
  const shown = holder(server);
  let refuse!: (ok: boolean) => void;
  const sent = new Promise<boolean>((r) => { refuse = r; });

  optimisticEdit((b) => moveCard(b, "c1", "review"), () => sent, shown.set, () => server);
  expect(columnOf(render(shown.get()), "c1")).toBe("Review"); // painted at once

  refuse(false);
  await sent; await Promise.resolve();
  expect(shown.get()).toBe(server);
  expect(render(shown.get())).toBe(render(server));
  expect(columnOf(render(shown.get()), "c1")).toBe("Backlog");
});

test("an accepted move stays put until the server's echo replaces it", async () => {
  const server = serverBoard();
  const shown = holder(server);
  const sent = Promise.resolve(true);
  optimisticEdit((b) => moveCard(b, "c1", "review"), () => sent, shown.set, () => server);
  await sent; await Promise.resolve();
  expect(shown.get().cards[0]!.columnId).toBe("review");
});

test("a refusal restores the newest server board, not the one from before the edit", async () => {
  let server = serverBoard();
  const shown = holder(server);
  let refuse!: (ok: boolean) => void;
  const sent = new Promise<boolean>((r) => { refuse = r; });
  optimisticEdit((b) => moveCard(b, "c1", "review"), () => sent, shown.set, () => server);

  // Another tab deletes the card before our refusal comes back.
  server = { ...server, cards: [] };
  refuse(false);
  await sent; await Promise.resolve();
  expect(shown.get()).toBe(server);
  expect(columnOf(render(shown.get()), "c1")).toBeUndefined();
});

test("an edit with nothing to show just sends", () => {
  const server = serverBoard();
  const shown = holder(server);
  let calls = 0;
  optimisticEdit(null, () => { calls++; }, shown.set, () => server);
  expect(calls).toBe(1);
  expect(shown.get()).toBe(server);
});
