// tests/card-modal.test.ts — the card modal's pure decisions, DOM-free.
import { test, expect } from "bun:test";
import { sendTaskGate, deliveryToast, parseTouches, touchesText, staffingGate } from "../src/ui/CardModal";
import { defaultBoard, type Board, type Card } from "../src/lib/board";
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

// ---- the file-claim field and gate ----------------------------------------

const assignee = { id: "11111111-2222-4333-8444-555555555555", name: "VOLT" };

/** The default board with these cards on it. */
function boardWith(...cards: Partial<Card>[]): Board {
  const base = defaultBoard();
  return { ...base, cards: cards.map((k, i) => ({ id: `card_${i + 1}`, title: `C${i + 1}`, columnId: "backlog", ...k })) };
}

test("parseTouches reads one path per line, trimming blanks and empty lines", () => {
  expect(parseTouches("  src/lib/board.ts \n\n src/ui/*.tsx\n")).toEqual(["src/lib/board.ts", "src/ui/*.tsx"]);
});

test("parseTouches on an empty field is an empty claim", () => {
  expect(parseTouches("   \n \n")).toEqual([]);
});

test("touchesText renders the claim one path per line, and nothing for no claim", () => {
  expect(touchesText(["src/lib/board.ts", "src/ui/*.tsx"])).toBe("src/lib/board.ts\nsrc/ui/*.tsx");
  expect(touchesText(undefined)).toBe("");
});

test("staffingGate: open when no other card claims these files", () => {
  const g = staffingGate(boardWith({ id: "card_1", touches: ["src/lib/board.ts"] }), "card_1");
  expect(g.enabled).toBe(true);
});

test("staffingGate: closed, and says which card is in the way", () => {
  const b = boardWith(
    { id: "card_1", columnId: "in-progress", assignee, touches: ["src/ui/TheLine.tsx"] },
    { id: "card_2", touches: ["src/ui/*.tsx"] },
  );
  const g = staffingGate(b, "card_2");
  expect(g.enabled).toBe(false);
  expect(g.reason).toContain("card_1");
  expect(g.reason).toContain("src/ui/TheLine.tsx");
});
