// tests/card-modal.test.ts — the card modal's pure decisions, DOM-free.
import { test, expect } from "bun:test";
import { sendTaskGate, deliveryToast } from "../src/ui/CardModal";
import type { AgentStatus } from "../src/schema";

const agent = (o: Partial<AgentStatus>): AgentStatus =>
  ({ sessionId: "s", name: "VOLT", role: "r", ticket: null, state: "idle", doing: "", cwd: "/", branch: null, updatedAt: 0, ...o });

test("sendTaskGate: no assignee -> disabled, asks for one", () => {
  const g = sendTaskGate(null, []);
  expect(g.enabled).toBe(false);
  expect(g.reason).toContain("Assign");
});

test("sendTaskGate: assignee whose session ended -> disabled", () => {
  const g = sendTaskGate({ id: "gone", name: "VOLT" }, []);
  expect(g.enabled).toBe(false);
  expect(g.reason).toContain("ended");
});

test("sendTaskGate: a working assignee is not sent a fresh task (it would be /clear'd mid-work)", () => {
  const g = sendTaskGate({ id: "s", name: "VOLT" }, [agent({ state: "working" })]);
  expect(g.enabled).toBe(false);
  expect(g.reason).toContain("working");
});

test("sendTaskGate: a waiting assignee is not sent a task either", () => {
  const g = sendTaskGate({ id: "s", name: "VOLT" }, [agent({ state: "waiting" })]);
  expect(g.enabled).toBe(false);
  expect(g.reason).toContain("waiting");
});

test("sendTaskGate: an idle live assignee can be sent the task", () => {
  const g = sendTaskGate({ id: "s", name: "VOLT" }, [agent({ state: "idle" })]);
  expect(g.enabled).toBe(true);
});

test("deliveryToast says who was notified now and who will get it when their turn ends", () => {
  expect(deliveryToast([{ sessionId: "a", name: "VOLT", via: "typed" }])).toBe("Notified VOLT");
  expect(deliveryToast([{ sessionId: "a", name: "VOLT", via: "queued" }])).toBe("Queued for VOLT (busy) - lands when its turn ends");
  expect(deliveryToast([
    { sessionId: "a", name: "VOLT", via: "typed" },
    { sessionId: "b", name: "CADENCE", via: "queued" },
  ])).toBe("Notified VOLT; queued for CADENCE (busy)");
});

test("deliveryToast with nobody to tell says the comment was only saved", () => {
  expect(deliveryToast([])).toBe("No running agent to notify - comment saved");
});
