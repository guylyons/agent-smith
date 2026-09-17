// tests/claim-gate.test.ts — the staffing gate over HTTP: `touches` is editable
// through card-update, and spawn/card-assign refuse to put a second agent on
// files another active card already claims (unless force is passed).
import { test, expect } from "bun:test";
import { readSnapshot } from "../src/server";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = "/tmp/aw-claim-gate-test";

const A = "502d0e8c-8790-4804-b767-0549edfc959c";
const B = "11111111-2222-4333-8444-555555555555";

const valid = (o: object) => JSON.stringify({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "idle",
  doing: "x", cwd: "/", branch: "b", updatedAt: Date.now(), ...o,
});

async function server() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  writeFileSync(join(dir, `${A}.json`), valid({ sessionId: A, name: "VOLT" }));
  writeFileSync(join(dir, `${B}.json`), valid({ sessionId: B, name: "EMBER" }));
  const { makeServer } = await import("../src/server");
  const srv = makeServer(0);
  const base = `http://localhost:${srv.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const add = async (title: string) =>
    ((await (await post("/action/card-add", { columnId: "backlog", title })).json()) as any).cardId as string;
  const card = (id: string) => readSnapshot(dir, Date.now()).board.cards.find((k) => k.id === id)!;
  return { srv, base, post, add, card };
}

/** Stand a card up as an active claim: touches set, an agent on it, in progress. */
async function claim(post: any, cardId: string, touches: string[]) {
  await post("/action/card-update", { cardId, touches });
  await post("/action/card-assign", { cardId, sessionId: A });
  await post("/action/card-move", { cardId, toColumnId: "in-progress", author: "VOLT" });
}

// ---- card-update: editing the claim --------------------------------------

test("card-update stores touches, and an empty list clears them", async () => {
  const { srv, post, add, card } = await server();
  const id = await add("T");
  expect((await (await post("/action/card-update", { cardId: id, touches: [" src/lib/board.ts ", "src/ui/*.tsx"] })).json()).ok).toBe(true);
  expect(card(id).touches).toEqual(["src/lib/board.ts", "src/ui/*.tsx"]);
  await post("/action/card-update", { cardId: id, touches: [] });
  expect(card(id).touches).toBeUndefined();
  srv.stop(true);
});

test("card-update leaves touches alone when the field is absent", async () => {
  const { srv, post, add, card } = await server();
  const id = await add("T");
  await post("/action/card-update", { cardId: id, touches: ["src/lib/board.ts"] });
  await post("/action/card-update", { cardId: id, title: "Renamed" });
  expect(card(id).touches).toEqual(["src/lib/board.ts"]);
  srv.stop(true);
});

test("card-update refuses a touches value that is not a list of strings", async () => {
  const { srv, post, add } = await server();
  const id = await add("T");
  expect((await post("/action/card-update", { cardId: id, touches: "src/lib/board.ts" })).status).toBe(400);
  srv.stop(true);
});

// ---- card-assign ----------------------------------------------------------

test("card-assign is refused when another active card claims an overlapping file", async () => {
  const { srv, post, add, card } = await server();
  const first = await add("First");
  const second = await add("Second");
  await claim(post, first, ["src/ui/TheLine.tsx"]);
  await post("/action/card-update", { cardId: second, touches: ["src/ui/*.tsx"] });

  const res = await post("/action/card-assign", { cardId: second, sessionId: B });
  expect(res.status).toBe(409);
  const out = (await res.json()) as any;
  expect(out.ok).toBe(false);
  expect(out.error).toContain(first);
  expect(out.error).toContain("src/ui/TheLine.tsx");
  expect(card(second).assignee).toBeUndefined();
  srv.stop(true);
});

test("card-assign goes through with force: true", async () => {
  const { srv, post, add, card } = await server();
  const first = await add("First");
  const second = await add("Second");
  await claim(post, first, ["src/ui/TheLine.tsx"]);
  await post("/action/card-update", { cardId: second, touches: ["src/ui/TheLine.tsx"] });

  expect((await (await post("/action/card-assign", { cardId: second, sessionId: B, force: true })).json()).ok).toBe(true);
  expect(card(second).assignee!.id).toBe(B);
  srv.stop(true);
});

test("card-assign with disjoint touches is untouched by the gate", async () => {
  const { srv, post, add, card } = await server();
  const first = await add("First");
  const second = await add("Second");
  await claim(post, first, ["src/ui/TheLine.tsx"]);
  await post("/action/card-update", { cardId: second, touches: ["src/lib/merge.ts"] });

  expect((await (await post("/action/card-assign", { cardId: second, sessionId: B })).json()).ok).toBe(true);
  expect(card(second).assignee!.id).toBe(B);
  srv.stop(true);
});

test("unassigning is never blocked by a claim", async () => {
  const { srv, post, add, card } = await server();
  const first = await add("First");
  const second = await add("Second");
  await post("/action/card-update", { cardId: second, touches: ["src/ui/TheLine.tsx"] });
  await post("/action/card-assign", { cardId: second, sessionId: B });
  await claim(post, first, ["src/ui/TheLine.tsx"]);

  expect((await (await post("/action/card-assign", { cardId: second, sessionId: null })).json()).ok).toBe(true);
  expect(card(second).assignee).toBeUndefined();
  srv.stop(true);
});

test("a claim releases once its card reaches the done column", async () => {
  const { srv, post, add, card } = await server();
  const first = await add("First");
  const second = await add("Second");
  await claim(post, first, ["src/ui/TheLine.tsx"]);
  await post("/action/card-update", { cardId: second, touches: ["src/ui/TheLine.tsx"] });
  expect((await post("/action/card-assign", { cardId: second, sessionId: B })).status).toBe(409);

  await post("/action/card-move", { cardId: first, toColumnId: "done", author: "VOLT" });
  expect((await (await post("/action/card-assign", { cardId: second, sessionId: B })).json()).ok).toBe(true);
  expect(card(second).assignee!.id).toBe(B);
  srv.stop(true);
});

// ---- spawn ----------------------------------------------------------------

test("spawn for a card is refused when its touches overlap an active claim", async () => {
  const { srv, base, post, add } = await server();
  const first = await add("First");
  const second = await add("Second");
  await claim(post, first, ["src/ui/TheLine.tsx"]);
  await post("/action/card-update", { cardId: second, touches: ["src/ui/*.tsx"] });

  // A nonexistent folder on purpose: the gate must refuse BEFORE anything is
  // launched, so no test here can ever open a real terminal.
  const res = await post("/action/spawn", { cwd: "/no/such/folder", text: "go", cardId: second });
  expect(res.status).toBe(409);
  const out = (await res.json()) as any;
  expect(out.error).toContain(first);
  expect(out.error).toContain("src/ui/TheLine.tsx");
  expect(base).toBeTruthy();
  srv.stop(true);
});

test("spawn with force: true is past the claim gate (it fails later, on the folder)", async () => {
  const { srv, post, add } = await server();
  const first = await add("First");
  const second = await add("Second");
  await claim(post, first, ["src/ui/TheLine.tsx"]);
  await post("/action/card-update", { cardId: second, touches: ["src/ui/TheLine.tsx"] });

  const res = await post("/action/spawn", { cwd: "/no/such/folder", text: "go", cardId: second, force: true });
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toContain("folder not found");
  srv.stop(true);
});

test("spawn with no cardId is never gated", async () => {
  const { srv, post, add } = await server();
  const first = await add("First");
  await claim(post, first, ["src/**"]);
  const res = await post("/action/spawn", { cwd: "/no/such/folder", text: "go" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toContain("folder not found");
  srv.stop(true);
});
