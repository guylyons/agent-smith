import { test, expect } from "bun:test";
import type { Card } from "../src/lib/board";
import {
  newestCommentAt, unreadCommentCount, hasUnreadComments,
  markCardRead, primeMarks, pruneMarks, canPrime, loadMarks, type ReadMarks,
} from "../src/ui/cardUnread";

const ME = "You";

function card(id: string, comments: { author: string; at: number }[] = []): Card {
  return {
    id, title: id, columnId: "backlog",
    comments: comments.map((c, i) => ({ id: `${id}-c${i}`, text: "hi", ...c })),
  };
}

test("newestCommentAt is the latest stamp, or 0 with nothing to read", () => {
  expect(newestCommentAt(card("a", [{ author: "DALLAS", at: 5 }, { author: "DALLAS", at: 9 }]))).toBe(9);
  expect(newestCommentAt(card("a"))).toBe(0);
  expect(newestCommentAt({ id: "a", title: "a", columnId: "backlog" })).toBe(0);
});

test("comments newer than the mark are unread", () => {
  const c = card("a", [{ author: "DALLAS", at: 10 }, { author: "DALLAS", at: 20 }, { author: "DALLAS", at: 30 }]);
  expect(unreadCommentCount(c, { a: 10 }, ME)).toBe(2);
  expect(unreadCommentCount(c, { a: 30 }, ME)).toBe(0);
});

test("your own comments are never unread — you wrote them", () => {
  const c = card("a", [{ author: ME, at: 20 }, { author: "DALLAS", at: 30 }]);
  expect(unreadCommentCount(c, { a: 10 }, ME)).toBe(1);
  expect(unreadCommentCount(card("a", [{ author: ME, at: 20 }]), { a: 10 }, ME)).toBe(0);
});

test("a card with no mark counts every comment but your own", () => {
  // a card created after the baseline was taken: nothing on it has been read
  const c = card("new", [{ author: "DALLAS", at: 5 }, { author: ME, at: 6 }]);
  expect(unreadCommentCount(c, {}, ME)).toBe(1);
});

test("a card with no comments is never unread", () => {
  expect(hasUnreadComments(card("a"), {}, ME)).toBe(false);
  expect(hasUnreadComments({ id: "a", title: "a", columnId: "backlog" }, {}, ME)).toBe(false);
});

test("malformed comments are skipped, not crashed on", () => {
  const bad = {
    id: "a", title: "a", columnId: "backlog",
    comments: [
      { id: "1", author: "DALLAS", text: "ok", at: 50 },
      { id: "2", author: "DALLAS", text: "no stamp" },
      { id: "3", author: "DALLAS", text: "bad stamp", at: "soon" },
      null,
    ],
  } as unknown as Card;
  expect(unreadCommentCount(bad, { a: 10 }, ME)).toBe(1);
  expect(newestCommentAt(bad)).toBe(50);
});

test("opening a card marks everything on it read", () => {
  const c = card("a", [{ author: "DALLAS", at: 10 }, { author: "DALLAS", at: 30 }]);
  const next = markCardRead({}, c);
  expect(unreadCommentCount(c, next, ME)).toBe(0);
  expect(next).not.toBe({}); // a new object, never a mutation
});

test("marking a comment-less card read still silences the comments that arrive next", () => {
  const marks = markCardRead({}, card("a"));
  const later = card("a", [{ author: "DALLAS", at: 5 }]);
  expect(unreadCommentCount(later, marks, ME)).toBe(1);
});

test("marking one card read leaves the others alone", () => {
  const marks: ReadMarks = { b: 7 };
  expect(markCardRead(marks, card("a", [{ author: "DALLAS", at: 3 }]))).toEqual({ b: 7, a: 3 });
  expect(marks).toEqual({ b: 7 });
});

test("priming treats the whole board as already read", () => {
  const cards = [card("a", [{ author: "DALLAS", at: 10 }]), card("b"), card("c", [{ author: ME, at: 4 }])];
  const marks = primeMarks(cards);
  for (const c of cards) expect(unreadCommentCount(c, marks, ME)).toBe(0);
});

test("priming still lets the next comment through", () => {
  const marks = primeMarks([card("a", [{ author: "DALLAS", at: 10 }])]);
  expect(unreadCommentCount(card("a", [{ author: "DALLAS", at: 10 }, { author: "DALLAS", at: 11 }]), marks, ME)).toBe(1);
});

test("pruning drops marks for cards that no longer exist", () => {
  expect(pruneMarks({ a: 1, gone: 2 }, [card("a")])).toEqual({ a: 1 });
  expect(pruneMarks({}, [])).toEqual({});
});

test("an empty board is not a baseline", () => {
  // The first board the UI renders is the empty default, a moment before the
  // real one arrives over SSE. Priming against THAT stores nothing, and every
  // card on the real board then reads as unread.
  expect(canPrime([])).toBe(false);
  expect(canPrime([card("a")])).toBe(true);
});

test("priming an empty board would silence nothing", () => {
  expect(primeMarks([])).toEqual({});
  expect(unreadCommentCount(card("a", [{ author: "DALLAS", at: 1 }]), primeMarks([]), ME)).toBe(1);
});

test("an empty stored baseline is treated as no baseline at all", () => {
  // Indistinguishable from a prime that raced the empty default board, and
  // re-priming at the next real board is right either way — so it self-heals
  // rather than leaving a browser permanently lit up.
  const store: Record<string, string> = { "aw-read-comments": "{}" };
  const real = globalThis.localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  };
  try {
    expect(loadMarks()).toEqual({ marks: {}, primed: false });
    store["aw-read-comments"] = JSON.stringify({ a: 5 });
    expect(loadMarks()).toEqual({ marks: { a: 5 }, primed: true });
    store["aw-read-comments"] = "{not json";
    expect(loadMarks()).toEqual({ marks: {}, primed: false });
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = real;
  }
});
