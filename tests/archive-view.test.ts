import { test, expect } from "bun:test";
import { archivePrompt, archivedToast, neighbourAfter } from "../src/ui/archiveView";

test("the archive prompt names the count and the repo", () => {
  expect(archivePrompt(12, { kind: "repo", repo: "agent-smith" })).toBe("Archive 12 agent-smith cards?");
  expect(archivePrompt(1, { kind: "repo", repo: "tubetable" })).toBe("Archive 1 tubetable card?");
  expect(archivePrompt(3, { kind: "none" })).toBe("Archive 3 cards with no repo?");
  expect(archivePrompt(87, { kind: "all" })).toBe("Archive all 87 cards?");
  expect(archivePrompt(1, { kind: "all" })).toBe("Archive 1 card?");
});

test("the archived toast counts the batch", () => {
  expect(archivedToast(3)).toBe("Archived 3 cards");
  expect(archivedToast(1)).toBe("Archived 1 card");
  expect(archivedToast(0)).toBe("Nothing to archive");
});

test("focus moves to the next row, else the previous, else nowhere", () => {
  expect(neighbourAfter(["a", "b", "c"], "b")).toBe("c");
  expect(neighbourAfter(["a", "b", "c"], "c")).toBe("b");
  expect(neighbourAfter(["a"], "a")).toBeNull();
  expect(neighbourAfter(["a", "b"], "zz")).toBe("a");
});
