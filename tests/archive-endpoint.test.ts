// tests/archive-endpoint.test.ts — archive/restore over HTTP, and /events only
// resending the board when it changed.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import { readBoard, writeBoard, type Board } from "../src/lib/board";
import { archiveFile } from "../src/lib/archive";

const dir = fixtureDir("archive-endpoint");

const BOARD: Board = {
  columns: [
    { id: "backlog", name: "Backlog", instruction: "", stage: "todo" },
    { id: "done", name: "Done", instruction: "", stage: "done" },
    { id: "merged", name: "Merged", instruction: "" },
  ],
  cards: [
    { id: "m1", title: "M1", columnId: "merged", comments: [{ id: "c1", author: "You", text: "Merged a into main.", at: 1 }] },
    { id: "m2", title: "M2", columnId: "merged" },
    { id: "b1", title: "B1", columnId: "backlog" },
  ],
};

async function start() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  writeBoard(dir, BOARD);
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { quit: async () => ({ ok: true }) });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { server, base, post };
}

test("column-archive moves a merged column's cards to the archive file, comments kept", async () => {
  const { server, base, post } = await start();
  const res = await post("/action/column-archive", { columnId: "merged" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, archived: 2, ids: ["m1", "m2"] });
  expect(readBoard(dir).cards.map((k) => k.id)).toEqual(["b1"]);
  const onDisk = JSON.parse(readFileSync(archiveFile(dir), "utf8"));
  expect(onDisk.cards.map((k: any) => k.id).sort()).toEqual(["m1", "m2"]);

  const list = (await (await fetch(`${base}/archive`)).json()) as { cards: any[] };
  expect(list.cards.map((k) => k.id).sort()).toEqual(["m1", "m2"]);
  expect(list.cards.find((k) => k.id === "m1").comments[0].text).toBe("Merged a into main.");

  // the snapshot carries only the count, not the cards
  const snap = (await (await fetch(`${base}/board`)).json()) as { board: Board };
  expect(snap.board.cards.length).toBe(1);
  server.stop(true);
});

test("column-archive refuses a column whose work hasn't landed", async () => {
  const { server, post } = await start();
  const res = await post("/action/column-archive", { columnId: "backlog" });
  expect(res.status).toBe(400);
  expect(readBoard(dir).cards.length).toBe(3);
  const missing = await post("/action/column-archive", { columnId: "nope" });
  expect(missing.status).toBe(404);
  server.stop(true);
});

test("column-archive with olderThanDays keeps recent cards", async () => {
  const { server, post } = await start();
  const b = readBoard(dir);
  b.cards[1]!.comments = [{ id: "c2", author: "You", text: "Merged.", at: Date.now() }];
  writeBoard(dir, b);
  const res = await post("/action/column-archive", { columnId: "merged", olderThanDays: 7 });
  expect(await res.json()).toEqual({ ok: true, archived: 1, ids: ["m1"] });
  expect(readBoard(dir).cards.map((k) => k.id).sort()).toEqual(["b1", "m2"]);
  server.stop(true);
});

test("card-unarchive puts the card back in Merged with its comments", async () => {
  const { server, base, post } = await start();
  await post("/action/column-archive", { columnId: "merged" });
  const res = await post("/action/card-unarchive", { cardId: "m1" });
  expect(await res.json()).toEqual({ ok: true });
  const m1 = readBoard(dir).cards.find((k) => k.id === "m1")!;
  expect(m1.columnId).toBe("merged");
  expect(m1.comments![0]!.text).toBe("Merged a into main.");
  const list = (await (await fetch(`${base}/archive`)).json()) as { cards: any[] };
  expect(list.cards.map((k) => k.id)).toEqual(["m2"]);
  const again = await post("/action/card-unarchive", { cardId: "m1" });
  expect(again.status).toBe(404);
  server.stop(true);
});

test("a corrupt archive file blocks archiving rather than being overwritten", async () => {
  const { server, post } = await start();
  writeFileSync(archiveFile(dir), "{ half written");
  const res = await post("/action/column-archive", { columnId: "merged" });
  expect(res.status).toBe(500);
  expect(readBoard(dir).cards.length).toBe(3);
  expect(readFileSync(archiveFile(dir), "utf8")).toBe("{ half written");
  server.stop(true);
});

// ---- /events: resend the board only when it changed --------------------------

/** Read SSE data events off a stream, skipping keep-alive comments. */
function events(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    async next(): Promise<any> {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) return JSON.parse(chunk.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value);
      }
    },
    cancel: () => reader.cancel(),
  };
}

test("/events sends the board on connect, then leaves it out of pushes where it didn't change", async () => {
  const { server, base, post } = await start();
  const ev = events(await fetch(`${base}/events`));
  const first = await ev.next();
  expect(first.board.cards.length).toBe(3);
  expect(first.archived).toBe(0);

  // An agent's status file changes: agents are resent, the board is not.
  writeFileSync(join(dir, "a.json"), JSON.stringify({
    sessionId: "a", name: "A", role: "r", ticket: "#1", state: "working",
    doing: "x", cwd: "/", branch: "b", updatedAt: Date.now(),
  }));
  const agentsOnly = await ev.next();
  expect(agentsOnly.agents.map((a: any) => a.sessionId)).toEqual(["a"]);
  expect("board" in agentsOnly).toBe(false);
  expect("mood" in agentsOnly).toBe(false);

  // A board write: the board comes along again.
  await post("/action/column-archive", { columnId: "merged" });
  let withBoard = await ev.next();
  while (!("board" in withBoard)) withBoard = await ev.next();
  expect(withBoard.board.cards.map((k: any) => k.id)).toEqual(["b1"]);
  expect(withBoard.archived).toBe(2);
  await ev.cancel();
  server.stop(true);
});

test("column-archive with cardIds archives only those cards (a repo-filtered view)", async () => {
  const { server, post } = await start();
  const res = await post("/action/column-archive", { columnId: "merged", cardIds: ["m2", "b1"] });
  // b1 is in Backlog, so it is not archivable even when named.
  expect(await res.json()).toEqual({ ok: true, archived: 1, ids: ["m2"] });
  expect(readBoard(dir).cards.map((k) => k.id).sort()).toEqual(["b1", "m1"]);
  server.stop(true);
});

test("card-unarchive with cardIds restores a whole batch in its old order (UNDO)", async () => {
  const { server, post } = await start();
  const archived = (await (await post("/action/column-archive", { columnId: "merged" })).json()) as { ids: string[] };
  expect(archived.ids).toEqual(["m1", "m2"]);
  const res = await post("/action/card-unarchive", { cardIds: archived.ids });
  expect(await res.json()).toEqual({ ok: true });
  expect(readBoard(dir).cards.filter((k) => k.columnId === "merged").map((k) => k.id)).toEqual(["m1", "m2"]);
  const again = await post("/action/card-unarchive", { cardIds: archived.ids });
  expect(again.status).toBe(404);
  server.stop(true);
});
