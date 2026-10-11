// tests/mention-complete.test.ts
import { test, expect } from "bun:test";
import { mentionQuery, mentionOptions, applyMention } from "../src/ui/mentionComplete";

test("mentionQuery finds the @word the caret is in", () => {
  expect(mentionQuery("hi @DA", 6)).toEqual({ start: 3, query: "DA" });
  expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionQuery("hi @DA more", 6)).toEqual({ start: 3, query: "DA" });
  expect(mentionQuery("ask @vasquez-8e", 15)).toEqual({ start: 4, query: "vasquez-8e" });
});

test("mentionQuery is null outside a mention, and for an email", () => {
  expect(mentionQuery("hi DA", 5)).toBeNull();
  expect(mentionQuery("a@b", 3)).toBeNull();
  expect(mentionQuery("@DA done", 8)).toBeNull();
});

const a = (sessionId: string, name: string, crew?: { id: string; name: string }) => ({ sessionId, name, ...(crew ? { crew } : {}) });

test("mentionOptions lists live agents by prefix of name or crew id", () => {
  const agents = [a("s1", "DALLAS", { id: "dallas-1a2b", name: "DALLAS" }), a("s2", "RIPLEY", { id: "ripley-3f2a", name: "RIPLEY" })];
  expect(mentionOptions("", agents).map((o) => o.insert)).toEqual(["DALLAS", "RIPLEY"]);
  expect(mentionOptions("da", agents).map((o) => o.insert)).toEqual(["DALLAS"]);
  expect(mentionOptions("ripley-3", agents).map((o) => o.insert)).toEqual(["RIPLEY"]);
  expect(mentionOptions("zz", agents)).toEqual([]);
});

test("two desks sharing a name complete to their crew ids", () => {
  const agents = [
    a("d8c1ebad", "DALLAS d8c1", { id: "dallas-1a2b", name: "DALLAS" }),
    a("93a0ffff", "DALLAS 93a0", { id: "dallas-9f9f", name: "DALLAS" }),
  ];
  expect(mentionOptions("dal", agents).map((o) => o.insert)).toEqual(["dallas-1a2b", "dallas-9f9f"]);
});

test("applyMention replaces the @word with the pick and a space", () => {
  expect(applyMention("hi @DA", { start: 3, query: "DA" }, 6, "DALLAS")).toEqual({ text: "hi @DALLAS ", caret: 11 });
  expect(applyMention("hi @DA more", { start: 3, query: "DA" }, 6, "DALLAS")).toEqual({ text: "hi @DALLAS more", caret: 10 });
});
