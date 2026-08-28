import { test, expect } from "bun:test";
import { assignedCardLabel } from "../src/ui/Crew";
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
