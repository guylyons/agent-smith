// tests/self-assign.test.ts — the SessionStart hook's card-assign (selfAssign)
// binds the card it was spawned for, but never takes it from a different
// agent who is on it and alive (#109). A human's card-assign still reassigns.
import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { readSnapshot } from "../src/server";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = fixtureDir("self-assign-test");

const A = "502d0e8c-8790-4804-b767-0549edfc959c";
const B = "11111111-2222-4333-8444-555555555555";
const A2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const valid = (o: object) => JSON.stringify({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "idle",
  doing: "x", cwd: "/", branch: "b", updatedAt: Date.now(), ...o,
});

async function server() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  writeFileSync(join(dir, `${A}.json`), valid({ sessionId: A, name: "VOLT", crew: { id: "volt-1a2b", name: "VOLT" } }));
  writeFileSync(join(dir, `${B}.json`), valid({ sessionId: B, name: "EMBER", crew: { id: "ember-3c4d", name: "EMBER" } }));
  const { makeServer } = await import("../src/server");
  const srv = makeServer(0);
  const base = `http://localhost:${srv.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const add = async (title: string) =>
    ((await (await post("/action/card-add", { columnId: "backlog", title })).json()) as any).cardId as string;
  const card = (id: string) => readSnapshot(dir, Date.now()).board.cards.find((k) => k.id === id)!;
  return { srv, post, add, card };
}

test("a self-assign onto a card a different live agent holds is refused, and the card is left alone", async () => {
  const { srv, post, add, card } = await server();
  const id = await add("T");
  await post("/action/card-assign", { cardId: id, sessionId: B });
  const res = await post("/action/card-assign", { cardId: id, sessionId: A, selfAssign: true });
  expect(res.status).toBe(409);
  const body = (await res.json()) as any;
  expect(body.ok).toBe(false);
  expect(body.delivery).toBeUndefined(); // nobody was told they were taken off
  expect(card(id).assignee?.id).toBe(B);
  srv.stop(true);
});

test("a self-assign onto an unassigned card binds it", async () => {
  const { srv, post, add, card } = await server();
  const id = await add("T");
  expect(((await (await post("/action/card-assign", { cardId: id, sessionId: A, selfAssign: true })).json()) as any).ok).toBe(true);
  expect(card(id).assignee?.id).toBe(A);
  srv.stop(true);
});

test("a self-assign takes a card whose assignee is no longer running", async () => {
  const { srv, post, add, card } = await server();
  const id = await add("T");
  await post("/action/card-assign", { cardId: id, sessionId: B });
  rmSync(join(dir, `${B}.json`));
  expect(((await (await post("/action/card-assign", { cardId: id, sessionId: A, selfAssign: true })).json()) as any).ok).toBe(true);
  expect(card(id).assignee?.id).toBe(A);
  srv.stop(true);
});

test("a self-assign by the same crew under a new session id is not a conflict", async () => {
  const { srv, post, add, card } = await server();
  const id = await add("T");
  await post("/action/card-assign", { cardId: id, sessionId: A });
  writeFileSync(join(dir, `${A2}.json`), valid({ sessionId: A2, name: "VOLT", crew: { id: "volt-1a2b", name: "VOLT" } }));
  expect(((await (await post("/action/card-assign", { cardId: id, sessionId: A2, selfAssign: true })).json()) as any).ok).toBe(true);
  expect(card(id).assignee?.id).toBe(A2);
  srv.stop(true);
});

test("a human's card-assign (no selfAssign) still reassigns from a live agent", async () => {
  const { srv, post, add, card } = await server();
  const id = await add("T");
  await post("/action/card-assign", { cardId: id, sessionId: B });
  expect(((await (await post("/action/card-assign", { cardId: id, sessionId: A })).json()) as any).ok).toBe(true);
  expect(card(id).assignee?.id).toBe(A);
  srv.stop(true);
});
