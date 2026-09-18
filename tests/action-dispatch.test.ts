// tests/action-dispatch.test.ts
// The /action/* dispatcher: the CSRF gate lives inside it, so no handler can be
// reached without passing the gate, whatever order the handlers are declared in.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import { dispatchAction, type ActionHandler } from "../src/lib/actionDispatch";

const req = (action: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/action/${action}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

function recorder() {
  const calls: { name: string; body: unknown; action: string }[] = [];
  const make = (name: string): ActionHandler<unknown> => (ctx) => {
    calls.push({ name, body: ctx.body, action: ctx.action });
    return new Response(name);
  };
  return { calls, handlers: { ping: make("ping") } as Record<string, ActionHandler<unknown>>, fallback: make("fallback") };
}

test("a cross-site POST is refused before any handler runs", async () => {
  for (const site of ["cross-site", "same-site"]) {
    const { calls, handlers, fallback } = recorder();
    const res = await dispatchAction(req("ping", "{}", { "sec-fetch-site": site }), handlers, fallback);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "cross-site blocked" });
    expect(calls).toEqual([]);
  }
});

test("same-origin, none, and header-less (curl) requests reach the handler", async () => {
  for (const headers of [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}] as Record<string, string>[]) {
    const { calls, handlers, fallback } = recorder();
    const res = await dispatchAction(req("ping", '{"x":1}', headers), handlers, fallback);
    expect(await res.text()).toBe("ping");
    expect(calls).toEqual([{ name: "ping", body: { x: 1 }, action: "ping" }]);
  }
});

test("a body that isn't JSON is a 400 and runs nothing", async () => {
  const { calls, handlers, fallback } = recorder();
  const res = await dispatchAction(req("ping", "{ nope"), handlers, fallback);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ ok: false, error: "bad body" });
  expect(calls).toEqual([]);
});

test("the gate runs before the body is read: a cross-site junk body is 403, not 400", async () => {
  const { handlers, fallback } = recorder();
  const res = await dispatchAction(req("ping", "{ nope", { "sec-fetch-site": "cross-site" }), handlers, fallback);
  expect(res.status).toBe(403);
});

test("unknown actions, including Object.prototype names, go to the fallback", async () => {
  for (const action of ["nope", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const { calls, handlers, fallback } = recorder();
    const res = await dispatchAction(req(action, "{}"), handlers, fallback);
    expect(await res.text()).toBe("fallback");
    expect(calls.map((c) => [c.name, c.action])).toEqual([["fallback", action]]);
  }
});

// ---- through the real server: the dispatch edges behave as they always have

const dir = fixtureDir("action-dispatch-test");

type Post = (path: string, body: string, headers?: Record<string, string>) => Promise<Response>;

async function withServer(fn: (post: Post, base: string) => Promise<void>) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0);
  const base = `http://localhost:${server.port}`;
  try {
    await fn((path, body, headers = {}) => fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body,
    }), base);
  } finally {
    server.stop(true);
  }
}

test("server: a cross-site card-add is blocked and writes nothing", async () => {
  await withServer(async (post, base) => {
    const board = await (await fetch(`${base}/board`)).json();
    const res = await post("/action/card-add", JSON.stringify({ columnId: board.board.columns[0].id, title: "sneaky" }), { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    const after = await (await fetch(`${base}/board`)).json();
    expect(after.board.cards.some((c: { title: string }) => c.title === "sneaky")).toBe(false);
  });
});

test("server: bad JSON on a real action is a 400 bad body", async () => {
  await withServer(async (post) => {
    const res = await post("/action/card-add", "{ nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "bad body" });
  });
});

test("server: an unknown action answers as it always has (session checks first)", async () => {
  await withServer(async (post) => {
    for (const action of ["nope", "constructor", "toString"]) {
      let res = await post(`/action/${action}`, "{}");
      expect([res.status, await res.json()]).toEqual([400, { ok: false, error: "bad sessionId" }]);
      res = await post(`/action/${action}`, JSON.stringify({ sessionId: "ghost" }));
      expect([res.status, await res.json()]).toEqual([404, { ok: false, error: "unknown session" }]);
    }
    writeFileSync(join(dir, "live.json"), JSON.stringify({
      sessionId: "live", name: "A", role: "r", ticket: "#1", state: "idle",
      doing: "x", cwd: "/", branch: "b", updatedAt: 9_999_999_999_999,
    }));
    const res = await post("/action/nope", JSON.stringify({ sessionId: "live" }));
    expect([res.status, await res.json()]).toEqual([404, { ok: false, error: "unknown action" }]);
  });
});
