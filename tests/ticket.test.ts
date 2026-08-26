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
