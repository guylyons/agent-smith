// tests/send-task-ready.test.ts — the one rule both the SEND TASK button and
// the server's send-task handler ask: is this card's assignee live and idle?
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { sendTaskReadiness } from "../src/lib/sendTaskReady";
import type { AgentStatus } from "../src/schema";

const agent = (o: Partial<AgentStatus>): AgentStatus =>
  ({ sessionId: "s", name: "VOLT", role: "r", ticket: null, state: "idle", doing: "", cwd: "/", branch: null, updatedAt: 0, ...o });

test("sendTaskReadiness: no assignee -> not ready, unassigned", () => {
  expect(sendTaskReadiness(null, [agent({})])).toEqual({ ready: false, why: "unassigned" });
  expect(sendTaskReadiness(undefined, [agent({})])).toEqual({ ready: false, why: "unassigned" });
});

test("sendTaskReadiness: assignee whose session ended -> not ready, ended", () => {
  const assignee = { id: "gone", name: "VOLT" };
  expect(sendTaskReadiness(assignee, [agent({ sessionId: "other" })])).toEqual({ ready: false, why: "ended", assignee });
});

test("sendTaskReadiness: a working assignee is not ready", () => {
  const volt = agent({ state: "working" });
  expect(sendTaskReadiness({ id: "s", name: "VOLT" }, [volt])).toEqual({ ready: false, why: "working", agent: volt });
});

test("sendTaskReadiness: a waiting assignee is not ready", () => {
  const volt = agent({ state: "waiting" });
  expect(sendTaskReadiness({ id: "s", name: "VOLT" }, [volt])).toEqual({ ready: false, why: "waiting", agent: volt });
});

test("sendTaskReadiness: an idle live assignee is ready, and the session is handed back", () => {
  const volt = agent({ state: "idle" });
  const r = sendTaskReadiness({ id: "s", name: "VOLT" }, [agent({ sessionId: "other" }), volt]);
  expect(r).toEqual({ ready: true, agent: volt });
  if (r.ready) expect(r.agent).toBe(volt);
});

test("sendTaskReadiness: finds the assignee by crew after a /clear gave it a new session id", () => {
  const cleared = agent({ sessionId: "s2", crew: { id: "volt-1234", name: "VOLT" } });
  expect(sendTaskReadiness({ id: "s1", name: "VOLT", crew: "volt-1234" }, [cleared])).toEqual({ ready: true, agent: cleared });
});

test("sendTaskReady.ts stays browser-safe: no runtime imports of fs, crew.ts or zod", () => {
  const src = readFileSync(new URL("../src/lib/sendTaskReady.ts", import.meta.url), "utf8");
  const runtimeImports = src.split("\n").filter((l) => /^\s*(import|export)\b(?!\s+type\b).*\bfrom\s+["']/.test(l));
  for (const l of runtimeImports) expect(l).not.toMatch(/["'](node:)?fs["']|crew["']|zod["']/);
});
