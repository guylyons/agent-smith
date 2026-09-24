// tests/merge-hint.test.ts — what the card modal says when there's no MERGE
// key on a card that's waiting in Review or Done (src/lib/mergeHint.ts).
import { test, expect } from "bun:test";
import { mergeHint, type MergeRead } from "../src/lib/mergeHint";
import { defaultBoard, type Board, type Card } from "../src/lib/board";
import type { MergeState } from "../src/lib/merge";

const card = (columnId: string): Card => ({ id: "card_1", title: "Notifications", columnId } as Card);
const withMerged = (): Board => {
  const b = defaultBoard();
  return { ...b, columns: [...b.columns, { id: "merged", name: "Merged", instruction: "" }] };
};
const state = (over: Partial<MergeState> = {}): MergeRead => ({
  kind: "state",
  state: {
    repo: true, branch: "ag-6", base: "main", ahead: 0, dirty: false, rootBranch: "main", rootDirty: false,
    committed: false, ready: false, blocked: "nothing committed on ag-6 yet", merging: false, ...over,
  },
});

test("a card in Review with nothing to merge says so and offers the merged column", () => {
  const h = mergeHint(withMerged(), card("review"), state());
  expect(h).toEqual({ tone: "idle", text: "Nothing to merge: nothing committed on ag-6 yet.", moveTo: { id: "merged", name: "Merged" } });
});

test("a branch already in the trunk says it was merged outside the dashboard", () => {
  const h = mergeHint(withMerged(), card("review"), state({ landed: true }));
  expect(h?.text).toBe("ag-6 is already in main, merged outside the dashboard.");
  expect(h?.moveTo?.id).toBe("merged");
});

test("an unreadable merge state gives the reason and still offers the move", () => {
  const h = mergeHint(withMerged(), card("done"), { kind: "error", message: "no working directory known for VOLT" });
  expect(h).toEqual({ tone: "error", text: "Can't read this card's branch: no working directory known for VOLT.", moveTo: { id: "merged", name: "Merged" } });
});

test("while the state is loading the line says so, with no button yet", () => {
  expect(mergeHint(withMerged(), card("review"), { kind: "loading" })).toEqual({ tone: "loading", text: "Checking the branch…" });
});

test("committed work means the MERGE key speaks instead: no hint", () => {
  expect(mergeHint(withMerged(), card("review"), state({ committed: true, ahead: 2 }))).toBeNull();
});

test("only review- and done-stage cards get a hint", () => {
  expect(mergeHint(withMerged(), card("in-progress"), state())).toBeNull();
  expect(mergeHint(withMerged(), card("backlog"), { kind: "error", message: "x" })).toBeNull();
});

test("a card already in the merged column gets no hint", () => {
  // No Merged column: Done is where merged cards go, so a Done card is home.
  expect(mergeHint(defaultBoard(), card("done"), state())).toBeNull();
  // ...but a Review card on that board is offered Done.
  expect(mergeHint(defaultBoard(), card("review"), state())?.moveTo).toEqual({ id: "done", name: "Done" });
});

test("a board with no done column has nowhere to move to: no hint", () => {
  const b: Board = { columns: [{ id: "review", name: "Review", instruction: "", stage: "review" }], cards: [] };
  expect(mergeHint(b, card("review"), state())).toBeNull();
});

test("an unnamed merged column still has a name to show", () => {
  const b = withMerged();
  b.columns[4] = { ...b.columns[4]!, name: "" };
  expect(mergeHint(b, card("review"), state())?.moveTo?.name).toBe("Untitled");
});

test("a reason that already ends in punctuation isn't doubled", () => {
  const h = mergeHint(withMerged(), card("review"), { kind: "error", message: "gone." });
  expect(h?.text).toBe("Can't read this card's branch: gone.");
});
