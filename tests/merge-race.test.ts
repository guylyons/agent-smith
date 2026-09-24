// tests/merge-race.test.ts — the MERGE key re-reads the card's merge state on
// the confirming press, and words a refusal caused by the state moving since
// the key lit up as exactly that, with a next step, instead of a bare error.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { mergeGate, mergeRefusal, previewKey } from "../src/lib/mergeRace";
import type { MergeState } from "../src/lib/merge";

const state = (o: Partial<MergeState> = {}): MergeState => ({
  repo: true, branch: "ag-6", base: "main", ahead: 2, tip: "a".repeat(40), dirty: false, rootBranch: "main", rootDirty: false, baseCheckedOut: true,
  committed: true, ready: true, blocked: "", merging: false, ...o,
});

test("mergeGate: still ready on the re-check -> send the merge", () => {
  expect(mergeGate(state())).toEqual({ go: true });
});

test("mergeGate: the tree went dirty since render -> hold, say it changed, suggest trying again", () => {
  const g = mergeGate(state({ ready: false, dirty: true, blocked: "ag-6 has uncommitted changes — commit them first" }));
  expect(g.go).toBe(false);
  if (!g.go) {
    expect(g.message).toMatch(/changed/i);
    expect(g.message).toContain("ag-6 has uncommitted changes");
    expect(g.message).toMatch(/try again/i);
  }
});

test("mergeGate: another card's merge is landing -> say so once, try again in a moment", () => {
  const g = mergeGate(state({ ready: false, merging: true, blocked: "a merge is in progress — try again in a moment" }));
  expect(g.go).toBe(false);
  if (!g.go) {
    expect(g.message).toMatch(/another merge/i);
    expect(g.message).toContain("main");
    expect(g.message.match(/try again/gi)?.length).toBe(1);
  }
});

test("mergeGate: the work is gone (already landed) -> nothing to merge, no retry offered", () => {
  const g = mergeGate(state({ committed: false, ready: false, ahead: 0, blocked: "nothing committed on ag-6 yet" }));
  expect(g.go).toBe(false);
  if (!g.go) {
    expect(g.message).toMatch(/nothing to merge/i);
    expect(g.message).not.toMatch(/try again/i);
  }
});

test("mergeGate: the re-check itself failed -> nothing sent, try again", () => {
  const g = mergeGate(null);
  expect(g.go).toBe(false);
  if (!g.go) {
    expect(g.message).toMatch(/nothing was merged/i);
    expect(g.message).toMatch(/try again/i);
  }
});

test("mergeRefusal: server refused and the state has moved -> the race message, not the raw error", () => {
  const fresh = state({ ready: false, rootDirty: true, blocked: "your main checkout has uncommitted changes" });
  const msg = mergeRefusal("your main checkout has uncommitted changes", fresh);
  expect(msg).toMatch(/changed/i);
  expect(msg).toMatch(/try again/i);
  expect(msg).toContain("your main checkout has uncommitted changes");
});

test("mergeRefusal: server refused but the state still reads ready (a conflict) -> the server's own words", () => {
  const err = "could not merge ag-6 into main — CONFLICT (content): Merge conflict in f";
  expect(mergeRefusal(err, state())).toBe(err);
});

test("mergeRefusal: no fresh state to compare -> the server's own words", () => {
  expect(mergeRefusal("not a git repository", null)).toBe("not a git repository");
});

test("mergeRace.ts stays browser-safe: type-only imports", () => {
  const src = readFileSync(new URL("../src/lib/mergeRace.ts", import.meta.url), "utf8");
  const runtimeImports = src.split("\n").filter((l) => /^\s*(import|export)\b(?!\s+type\b).*\bfrom\s+["']/.test(l));
  expect(runtimeImports).toEqual([]);
});

test("the MERGE key re-reads the state before it sends the merge", () => {
  const src = readFileSync(new URL("../src/ui/MergeKey.tsx", import.meta.url), "utf8");
  const fire = src.slice(src.indexOf("async function fire"));
  const recheck = fire.indexOf("mergeGate(");
  const send = fire.indexOf("mergeCard(");
  expect(recheck).toBeGreaterThan(-1);
  expect(send).toBeGreaterThan(recheck);
});

// An amend (or rebase) that keeps the count still moves the tip: the preview
// must re-read, and a merge of what was shown must be held.
test("previewKey: an amend with the same count changes the key", () => {
  const before = state();
  const amended = state({ tip: "b".repeat(40) });
  expect(amended.ahead).toBe(before.ahead);
  expect(previewKey(amended)).not.toBe(previewKey(before));
  expect(previewKey(state())).toBe(previewKey(before));
});

test("mergeGate: the tip moved since the preview was read -> hold, review again", () => {
  const g = mergeGate(state({ tip: "b".repeat(40) }), "a".repeat(40));
  expect(g.go).toBe(false);
  if (!g.go) expect(g.message).toMatch(/moved since you looked; review again/);
  expect(mergeGate(state(), "a".repeat(40))).toEqual({ go: true });
});

test("the MERGE key keys the preview on previewKey and sends the tip it showed", () => {
  const src = readFileSync(new URL("../src/ui/MergeKey.tsx", import.meta.url), "utf8");
  expect(src).toContain("refresh={previewKey(state)}");
  expect(src).not.toContain("state.ahead}`} />");
  const fire = src.slice(src.indexOf("async function fire"));
  expect(fire).toMatch(/mergeGate\(await reload\(\), seen\)/);
  expect(fire).toMatch(/mergeCard\(cardId, seen\)/);
});
