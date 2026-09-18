import { test, expect } from "bun:test";
import { assignedCardLabel, deskTicket } from "../src/ui/Crew";
import type { AgentStatus } from "../src/schema";
import { defaultBoard, addCard, assignCard, moveCard } from "../src/lib/board";

const SID = "3e21f496-612c-49f0-93a8-2570a87b2100";

test("assignedCardLabel names the card and its column", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  b = assignCard(b, b.cards[0]!.id, { id: SID, name: "NOVA" });
  b = moveCard(b, b.cards[0]!.id, "in-progress");
  expect(assignedCardLabel(b, SID)).toBe("Fix login bug · In Progress");
});

test("assignedCardLabel counts extra cards and is empty when unassigned", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "one");
  b = addCard(b, "backlog", "two");
  b = assignCard(b, b.cards[0]!.id, { id: SID, name: "NOVA" });
  b = assignCard(b, b.cards[1]!.id, { id: SID, name: "NOVA" });
  expect(assignedCardLabel(b, SID)).toBe("one · Backlog +1");
  expect(assignedCardLabel(b, "99999999-0000-4000-8000-000000000000")).toBe("");
});

const desk = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: SID, name: "NOVA", role: "r", ticket: null, state: "idle", doing: "", cwd: "/", branch: null, updatedAt: 0, ...o,
});

test("deskTicket comes from the assigned card, not the branch", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "AG-42: Something unrelated");
  b = assignCard(b, b.cards[0]!.id, { id: SID, name: "NOVA" });
  // still on the old card's branch — the badge must not keep saying #11
  expect(deskTicket(b, desk({ branch: "ag-11-right-hand-sidebar-the", ticket: "#11" }))).toBe("AG-42");
});

test("deskTicket follows the card across a /clear by crew id", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "No ticket in this title");
  const id = b.cards[0]!.id;
  b = assignCard(b, id, { id: "old-session", name: "NOVA", crew: "nova-1" });
  const out = deskTicket(b, desk({ ticket: "#11", crew: { id: "nova-1", name: "NOVA" } }));
  expect(out).toBe(id.replace(/^card_/, "").slice(0, 6));
});

test("deskTicket falls back to the branch ticket with no card", () => {
  const b = defaultBoard();
  expect(deskTicket(b, desk({ ticket: "#11" }))).toBe("#11");
  expect(deskTicket(b, desk({ ticket: null }))).toBeNull();
});
