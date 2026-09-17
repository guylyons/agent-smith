// tests/claims.test.ts — the file-claim registry: a card's `touches` set, and
// the pure gate that stops a second card being staffed on files another active
// card has already claimed. All DOM-free and filesystem-free.
import { test, expect } from "bun:test";
import {
  defaultBoard,
  sanitizeBoard,
  sanitizeCard,
  setCardTouches,
  globsOverlap,
  overlappingClaims,
  claimBlockReason,
  type Board,
  type Card,
} from "../src/lib/board";

/** A board with two cards, each placed and staffed as the test needs. */
function boardWith(...cards: Partial<Card>[]): Board {
  const base = defaultBoard();
  return {
    ...base,
    cards: cards.map((k, i) => ({
      id: k.id ?? `card_${i + 1}`,
      title: k.title ?? `Card ${i + 1}`,
      columnId: k.columnId ?? "backlog",
      ...k,
    })),
  };
}

const assignee = { id: "11111111-2222-4333-8444-555555555555", name: "VOLT" };

// ---- touches: the field itself -------------------------------------------

test("setCardTouches stores the paths, trimmed and de-duplicated", () => {
  const b = setCardTouches(boardWith({ id: "card_1" }), "card_1", ["  src/lib/board.ts ", "src/lib/board.ts", "src/ui/*.tsx"]);
  expect(b.cards[0]!.touches).toEqual(["src/lib/board.ts", "src/ui/*.tsx"]);
});

test("setCardTouches with an empty list drops the field rather than storing []", () => {
  const set = setCardTouches(boardWith({ id: "card_1" }), "card_1", ["src/x.ts"]);
  const cleared = setCardTouches(set, "card_1", ["", "   "]);
  expect(cleared.cards[0]!.touches).toBeUndefined();
});

test("setCardTouches does not mutate the board it was given", () => {
  const before = boardWith({ id: "card_1" });
  setCardTouches(before, "card_1", ["src/x.ts"]);
  expect(before.cards[0]!.touches).toBeUndefined();
});

test("sanitizeCard keeps a valid touches list and drops junk entries", () => {
  const card = sanitizeCard({ id: "k", title: "T", columnId: "backlog", touches: ["src/a.ts", 7, "", "src/a.ts", "src/b.ts"] });
  expect(card!.touches).toEqual(["src/a.ts", "src/b.ts"]);
});

test("sanitizeCard leaves a bare card bare (no touches key)", () => {
  const card = sanitizeCard({ id: "k", title: "T", columnId: "backlog" });
  expect("touches" in card!).toBe(false);
});

test("touches survives a sanitizeBoard round trip", () => {
  const b = setCardTouches(boardWith({ id: "card_1" }), "card_1", ["src/lib/board.ts"]);
  expect(sanitizeBoard(JSON.parse(JSON.stringify(b))).cards[0]!.touches).toEqual(["src/lib/board.ts"]);
});

// ---- glob overlap ---------------------------------------------------------

test("globsOverlap: identical paths overlap", () => {
  expect(globsOverlap("src/ui/TheLine.tsx", "src/ui/TheLine.tsx")).toBe(true);
});

test("globsOverlap: different files in the same directory do not", () => {
  expect(globsOverlap("src/ui/TheLine.tsx", "src/ui/CardModal.tsx")).toBe(false);
});

test("globsOverlap: a * pattern covers a literal file in that directory", () => {
  expect(globsOverlap("src/ui/*.tsx", "src/ui/CardModal.tsx")).toBe(true);
  expect(globsOverlap("src/ui/CardModal.tsx", "src/ui/*.tsx")).toBe(true);
});

test("globsOverlap: a * does not reach across a directory separator", () => {
  expect(globsOverlap("src/*.ts", "src/lib/board.ts")).toBe(false);
});

test("globsOverlap: ** does reach across separators", () => {
  expect(globsOverlap("src/**", "src/lib/board.ts")).toBe(true);
  expect(globsOverlap("src/**/*.ts", "src/lib/board.ts")).toBe(true);
});

test("globsOverlap: **/ also matches zero directories", () => {
  expect(globsOverlap("src/**/board.ts", "src/board.ts")).toBe(true);
});

test("globsOverlap: a trailing slash means the whole directory", () => {
  expect(globsOverlap("src/ui/", "src/ui/CardModal.tsx")).toBe(true);
  expect(globsOverlap("src/ui/", "src/lib/board.ts")).toBe(false);
});

test("globsOverlap: leading ./ and / are ignored so the same file written two ways still overlaps", () => {
  expect(globsOverlap("./src/lib/board.ts", "src/lib/board.ts")).toBe(true);
  expect(globsOverlap("/src/lib/board.ts", "src/lib/board.ts")).toBe(true);
});

test("globsOverlap: a blank entry overlaps nothing", () => {
  expect(globsOverlap("", "src/lib/board.ts")).toBe(false);
  expect(globsOverlap("   ", "")).toBe(false);
});

test("globsOverlap: a ? stands for one character, not a separator", () => {
  expect(globsOverlap("src/a?.ts", "src/ab.ts")).toBe(true);
  expect(globsOverlap("src/a?.ts", "src/abc.ts")).toBe(false);
});

test("globsOverlap: regex metacharacters in a path are literal", () => {
  expect(globsOverlap("src/a+b.ts", "src/a+b.ts")).toBe(true);
  expect(globsOverlap("src/a+b.ts", "src/aab.ts")).toBe(false);
});

// ---- overlappingClaims ----------------------------------------------------

test("overlappingClaims: an active card holding an overlapping path is reported", () => {
  const b = boardWith(
    { id: "card_a", title: "First", columnId: "in-progress", assignee, touches: ["src/ui/TheLine.tsx"] },
    { id: "card_b", title: "Second", columnId: "backlog", touches: ["src/ui/*.tsx"] },
  );
  const claims = overlappingClaims(b, "card_b");
  expect(claims.map((c) => c.cardId)).toEqual(["card_a"]);
  expect(claims[0]!.paths).toEqual(["src/ui/TheLine.tsx"]);
  expect(claims[0]!.stage).toBe("doing");
});

test("overlappingClaims: disjoint touches are no conflict", () => {
  const b = boardWith(
    { id: "card_a", columnId: "in-progress", assignee, touches: ["src/lib/board.ts"] },
    { id: "card_b", touches: ["src/ui/CardModal.tsx"] },
  );
  expect(overlappingClaims(b, "card_b")).toEqual([]);
});

test("overlappingClaims: a card with no touches is never blocked", () => {
  const b = boardWith(
    { id: "card_a", columnId: "in-progress", assignee, touches: ["src/**"] },
    { id: "card_b" },
  );
  expect(overlappingClaims(b, "card_b")).toEqual([]);
});

test("overlappingClaims: a card with no touches never blocks anyone else", () => {
  const b = boardWith(
    { id: "card_a", columnId: "in-progress", assignee },
    { id: "card_b", touches: ["src/**"] },
  );
  expect(overlappingClaims(b, "card_b")).toEqual([]);
});

test("overlappingClaims: an unstaffed card sitting in the backlog holds no claim", () => {
  // Both cards are planned against the same file, but nobody is on the first
  // one yet -- planning must not block staffing.
  const b = boardWith(
    { id: "card_a", columnId: "backlog", touches: ["src/lib/board.ts"] },
    { id: "card_b", columnId: "backlog", touches: ["src/lib/board.ts"] },
  );
  expect(overlappingClaims(b, "card_b")).toEqual([]);
});

test("overlappingClaims: an assigned card in the backlog does hold its claim", () => {
  const b = boardWith(
    { id: "card_a", columnId: "backlog", assignee, touches: ["src/lib/board.ts"] },
    { id: "card_b", touches: ["src/lib/board.ts"] },
  );
  expect(overlappingClaims(b, "card_b").map((c) => c.cardId)).toEqual(["card_a"]);
});

test("overlappingClaims: a card in review is still unmerged, so it still claims", () => {
  const b = boardWith(
    { id: "card_a", columnId: "review", touches: ["src/lib/board.ts"] },
    { id: "card_b", touches: ["src/lib/board.ts"] },
  );
  expect(overlappingClaims(b, "card_b").map((c) => c.cardId)).toEqual(["card_a"]);
});

test("overlappingClaims: the claim releases once the card reaches a done column", () => {
  const b = boardWith(
    { id: "card_a", columnId: "done", assignee, touches: ["src/lib/board.ts"] },
    { id: "card_b", touches: ["src/lib/board.ts"] },
  );
  expect(overlappingClaims(b, "card_b")).toEqual([]);
});

test("overlappingClaims: a card never conflicts with itself, so it can be re-staffed", () => {
  const b = boardWith({ id: "card_a", columnId: "in-progress", assignee, touches: ["src/lib/board.ts"] });
  expect(overlappingClaims(b, "card_a")).toEqual([]);
});

test("overlappingClaims: an unknown card id yields no claims", () => {
  expect(overlappingClaims(defaultBoard(), "card_nope")).toEqual([]);
});

test("overlappingClaims: every conflicting card is reported, with only the overlapping paths", () => {
  const b = boardWith(
    { id: "card_a", columnId: "in-progress", assignee, touches: ["src/ui/TheLine.tsx", "src/lib/merge.ts"] },
    { id: "card_b", columnId: "review", touches: ["src/ui/CardModal.tsx"] },
    { id: "card_c", touches: ["src/ui/*.tsx"] },
  );
  const claims = overlappingClaims(b, "card_c");
  expect(claims.map((c) => c.cardId)).toEqual(["card_a", "card_b"]);
  expect(claims[0]!.paths).toEqual(["src/ui/TheLine.tsx"]); // not src/lib/merge.ts
  expect(claims[1]!.paths).toEqual(["src/ui/CardModal.tsx"]);
});

// ---- claimBlockReason -----------------------------------------------------

test("claimBlockReason: null when nothing is in the way", () => {
  expect(claimBlockReason(boardWith({ id: "card_a", touches: ["src/x.ts"] }), "card_a")).toBeNull();
});

test("claimBlockReason: names the conflicting card, the path, where it sits, and the way out", () => {
  const b = boardWith(
    { id: "card_a", columnId: "in-progress", assignee, touches: ["src/ui/TheLine.tsx"] },
    { id: "card_b", touches: ["src/ui/*.tsx"] },
  );
  expect(claimBlockReason(b, "card_b")).toBe(
    "card_a already claims src/ui/TheLine.tsx (in doing) - wait for it to merge, or edit touches to remove the overlap",
  );
});

test("claimBlockReason: two conflicting cards are both named", () => {
  const b = boardWith(
    { id: "card_a", columnId: "in-progress", assignee, touches: ["src/ui/TheLine.tsx"] },
    { id: "card_b", columnId: "review", touches: ["src/ui/CardModal.tsx"] },
    { id: "card_c", touches: ["src/ui/*.tsx"] },
  );
  expect(claimBlockReason(b, "card_c")).toBe(
    "card_a already claims src/ui/TheLine.tsx (in doing), card_b already claims src/ui/CardModal.tsx (in review)" +
      " - wait for them to merge, or edit touches to remove the overlap",
  );
});

test("claimBlockReason: a stageless column is named by its own id", () => {
  const base = defaultBoard();
  const b: Board = {
    columns: [...base.columns, { id: "parked", name: "Parked", instruction: "" }],
    cards: [
      { id: "card_a", title: "A", columnId: "parked", assignee, touches: ["src/x.ts"] },
      { id: "card_b", title: "B", columnId: "backlog", touches: ["src/x.ts"] },
    ],
  };
  expect(claimBlockReason(b, "card_b")).toContain("(in parked)");
});

test("claimBlockReason is pure ASCII - it crosses a pty into an agent's terminal", () => {
  const b = boardWith(
    { id: "card_a", columnId: "in-progress", assignee, touches: ["src/ui/TheLine.tsx"] },
    { id: "card_b", touches: ["src/ui/TheLine.tsx"] },
  );
  // eslint-disable-next-line no-control-regex
  expect(/^[\x20-\x7e]*$/.test(claimBlockReason(b, "card_b")!)).toBe(true);
});
