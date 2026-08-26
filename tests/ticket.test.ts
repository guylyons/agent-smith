import { test, expect } from "bun:test";
import { parseTicket } from "../src/lib/ticket";

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
