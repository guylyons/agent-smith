// tests/merge-race.test.ts — the MERGE key re-reads the card's merge state on
// the confirming press, and words a refusal caused by the state moving since
// the key lit up as exactly that, with a next step, instead of a bare error.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { mergeGate, mergeRefusal } from "../src/lib/mergeRace";
import type { MergeState } from "../src/lib/merge";

const state = (o: Partial<MergeState> = {}): MergeState => ({
  repo: true, branch: "ag-6", base: "main", ahead: 2, dirty: false, rootBranch: "main", rootDirty: false,
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
