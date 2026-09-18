// tests/card-modal.test.ts — the card modal's pure decisions, DOM-free.
import { test, expect, afterEach } from "bun:test";
import { sendTaskGate, deliveryToast, parseTouches, touchesText, staffingGate, reassign } from "../src/ui/CardModal";
import { defaultBoard, type Board, type Card, type Assignee } from "../src/lib/board";
import { subscribeToasts, type Toast } from "../src/ui/toast";
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

// ---- reassigning, with UNDO ------------------------------------------------

// A stand-in for TheLine's mutate: applies the pure op to a local board and
// runs the server half, whose fetch is captured instead of sent.
function harness(start: Board) {
  let board = start;
  const sent: unknown[] = [];
  const toasts: Toast[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
  const unsubscribe = subscribeToasts((t) => toasts.push(t));
  cleanups.push(() => { globalThis.fetch = realFetch; unsubscribe(); });
  const mutate = (fn: ((b: Board) => Board) | null, send: () => void) => { if (fn) board = fn(board); send(); };
  return { mutate, sent, toasts, card: () => board.cards[0]! };
}
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const VOLT: Assignee = { id: "11111111-2222-4333-8444-555555555555", name: "VOLT", crew: "volt-1" };
const ORAM: Assignee = { id: "66666666-7777-4888-8999-000000000000", name: "ORAM" };

test("reassign: switching agents applies at once and toasts an UNDO that puts the old one back", () => {
  const h = harness(boardWith({ id: "card_1", assignee: VOLT }));
  reassign(h.mutate, "card_1", VOLT, ORAM);
  expect(h.card().assignee).toEqual(ORAM);
  expect(h.sent).toEqual([{ cardId: "card_1", sessionId: ORAM.id }]);
  expect(h.toasts).toHaveLength(1);
  expect(h.toasts[0]!.text).toContain("ORAM");
  expect(h.toasts[0]!.text).toContain("VOLT");
  expect(h.toasts[0]!.action?.label).toBe("UNDO");

  h.toasts[0]!.action!.run();
  expect(h.card().assignee).toEqual(VOLT);
  expect(h.sent[1]).toEqual({ cardId: "card_1", sessionId: VOLT.id });
});

test("reassign: clearing to Unassigned can be undone", () => {
  const h = harness(boardWith({ id: "card_1", assignee: VOLT }));
  reassign(h.mutate, "card_1", VOLT, null);
  expect(h.card().assignee).toBeNull();
  expect(h.sent).toEqual([{ cardId: "card_1", sessionId: null }]);
  expect(h.toasts[0]!.text).toContain("VOLT");

  h.toasts[0]!.action!.run();
  expect(h.card().assignee).toEqual(VOLT);
  expect(h.sent[1]).toEqual({ cardId: "card_1", sessionId: VOLT.id });
});

test("reassign: when the card was Unassigned, UNDO clears it again", () => {
  const h = harness(boardWith({ id: "card_1" }));
  reassign(h.mutate, "card_1", null, ORAM);
  expect(h.card().assignee).toEqual(ORAM);

  h.toasts[0]!.action!.run();
  expect(h.card().assignee).toBeNull();
  expect(h.sent[1]).toEqual({ cardId: "card_1", sessionId: null });
});
