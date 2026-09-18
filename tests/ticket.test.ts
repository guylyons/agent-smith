import { test, expect } from "bun:test";
import { parseTicket, cardTicket } from "../src/lib/ticket";

test("extracts number from feature branch", () => {
  expect(parseTicket("feature/4412-card-variant")).toBe("#4412");
});
test("handles bare number", () => {
  expect(parseTicket("4271")).toBe("#4271");
});
test("null branch -> null", () => {
  expect(parseTicket(null)).toBeNull();
});
test("no digits -> null", () => {
  expect(parseTicket("main")).toBeNull();
});
test("date-like segment is not a ticket", () => {
  expect(parseTicket("chore/2024-01-migration")).toBeNull();
});
test("digits glued to letters (d10/d11) are not a ticket", () => {
  expect(parseTicket("feature/d10-d11-upgrade")).toBeNull();
});
test("project-prefixed ticket (MHO-115)", () => {
  expect(parseTicket("MHO-115-nav")).toBe("#115");
});
test("project-prefixed ticket, lowercase, mid-branch (mho-123)", () => {
  expect(parseTicket("fix/mho-123-x")).toBe("#123");
});

// A desk's badge when its session holds a card: the card's own ticket, never
// the branch's (see deskTicket in src/ui/Crew.tsx).
test("cardTicket takes the ticket from the card title", () => {
  expect(cardTicket({ id: "card_1119e443", title: "AG-11: Right hand sidebar" })).toBe("AG-11");
  expect(cardTicket({ id: "card_1119e443", title: "fix ag-7 flicker" })).toBe("AG-7");
});
test("cardTicket falls back to a short card id when the title has no ticket", () => {
  expect(cardTicket({ id: "card_1119e443", title: "Desk badge follows the card" })).toBe("1119e4");
});
test("cardTicket ignores ticket-like text glued into a longer word", () => {
  expect(cardTicket({ id: "card_abcdef12", title: "upgrade v2-3x-11bar" })).toBe("abcdef");
});
