import { test, expect } from "bun:test";
import { initialIdle, onConnect, onDisconnect, shouldShutDown, type IdleState } from "../src/lib/idle";

const OPTS = { graceMs: 5_000, startupGraceMs: 30_000 };
const T0 = 1_000_000;

test("a server that just started is not idle yet", () => {
  const s = initialIdle(T0);
  expect(shouldShutDown(s, T0, OPTS)).toBe(false);
  expect(shouldShutDown(s, T0 + OPTS.startupGraceMs - 1, OPTS)).toBe(false);
});

test("a window that never turns up gives up after the startup grace", () => {
  // the browser failed to launch, or was killed before it loaded the page —
  // without this the launcher would sit there holding a server nobody can see
  const s = initialIdle(T0);
  expect(shouldShutDown(s, T0 + OPTS.startupGraceMs, OPTS)).toBe(true);
});

test("a connected window keeps the server up indefinitely", () => {
  const s = onConnect(initialIdle(T0), T0 + 500);
  expect(shouldShutDown(s, T0 + 500, OPTS)).toBe(false);
  expect(shouldShutDown(s, T0 + 86_400_000, OPTS)).toBe(false);
});

test("closing the last window shuts down, but only after the grace", () => {
  let s = onConnect(initialIdle(T0), T0 + 500);
  s = onDisconnect(s, T0 + 1_000);
  expect(shouldShutDown(s, T0 + 1_000, OPTS)).toBe(false);
  expect(shouldShutDown(s, T0 + 1_000 + OPTS.graceMs - 1, OPTS)).toBe(false);
  expect(shouldShutDown(s, T0 + 1_000 + OPTS.graceMs, OPTS)).toBe(true);
});

test("a reload inside the grace is not a close", () => {
  // the SSE stream drops and comes straight back on every refresh
  let s = onConnect(initialIdle(T0), T0);
  s = onDisconnect(s, T0 + 1_000);
  s = onConnect(s, T0 + 1_200);
  expect(shouldShutDown(s, T0 + 60_000, OPTS)).toBe(false);
});

test("a second close after a reload starts the grace over", () => {
  let s = onConnect(initialIdle(T0), T0);
  s = onDisconnect(s, T0 + 1_000);
  s = onConnect(s, T0 + 1_200);
  s = onDisconnect(s, T0 + 2_000);
  expect(shouldShutDown(s, T0 + 2_000 + OPTS.graceMs - 1, OPTS)).toBe(false);
  expect(shouldShutDown(s, T0 + 2_000 + OPTS.graceMs, OPTS)).toBe(true);
});

test("with two windows open, closing one changes nothing", () => {
  let s = onConnect(onConnect(initialIdle(T0), T0), T0);
  s = onDisconnect(s, T0 + 1_000);
  expect(shouldShutDown(s, T0 + 600_000, OPTS)).toBe(false);
  s = onDisconnect(s, T0 + 2_000);
  expect(shouldShutDown(s, T0 + 2_000 + OPTS.graceMs, OPTS)).toBe(true);
});

test("once a window has connected, the startup grace no longer applies", () => {
  const s = onConnect(initialIdle(T0), T0 + 100);
  expect(shouldShutDown(s, T0 + OPTS.startupGraceMs + 1, OPTS)).toBe(false);
});

test("a stray disconnect can't drive the client count negative", () => {
  // push() drops a client whose controller already closed, and cancel() may
  // still fire for it afterwards — the same window leaving twice
  let s: IdleState = onConnect(initialIdle(T0), T0);
  s = onDisconnect(s, T0 + 100);
  s = onDisconnect(s, T0 + 200);
  expect(s.clients).toBe(0);
  // one reconnect must be enough to hold the server up again
  s = onConnect(s, T0 + 300);
  expect(shouldShutDown(s, T0 + 600_000, OPTS)).toBe(false);
});

// ---- wired into the server -----------------------------------------------

const dir = "/tmp/aw-idle-server-test";

test("closing the last /events stream shuts the server down", async () => {
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  let closed = false;
  const server = makeServer(0, {
    onWindowsClosed: () => { closed = true; },
    idleGraceMs: 60, idleStartupGraceMs: 10_000, idleCheckMs: 10,
  });

  const ctrl = new AbortController();
  const res = await fetch(`http://localhost:${server.port}/events`, { signal: ctrl.signal });
  await res.body!.getReader().read(); // the initial snapshot frame

  await Bun.sleep(150);
  expect(closed).toBe(false); // a window is open; nothing should fire

  ctrl.abort(); // the window closes
  await Bun.sleep(300);
  expect(closed).toBe(true);
  server.stop(true);
});

test("a server nobody ever opens gives up on its own", async () => {
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  let closed = false;
  const server = makeServer(0, {
    onWindowsClosed: () => { closed = true; },
    idleGraceMs: 10_000, idleStartupGraceMs: 60, idleCheckMs: 10,
  });
  await Bun.sleep(300);
  expect(closed).toBe(true);
  server.stop(true);
});

test("without onWindowsClosed the server just keeps serving", async () => {
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer } = await import("../src/server");
  const server = makeServer(0, { idleGraceMs: 10, idleStartupGraceMs: 10, idleCheckMs: 10 });
  await Bun.sleep(200);
  const res = await fetch(`http://localhost:${server.port}/board`);
  expect(res.ok).toBe(true);
  server.stop(true);
});
