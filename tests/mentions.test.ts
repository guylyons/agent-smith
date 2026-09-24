import { test, expect } from "bun:test";
import { parseMentions, splitMentions, matchMentions } from "../src/lib/mentions";

test("parseMentions finds @NAME tokens and strips trailing punctuation", () => {
  expect(parseMentions("@DALLAS is the /card shape stable?")).toEqual(["DALLAS"]);
  expect(parseMentions("ask @dallas, then @RIPLEY.")).toEqual(["dallas", "RIPLEY"]);
  expect(parseMentions("(@BISHOP) and @ASH!")).toEqual(["BISHOP", "ASH"]);
  expect(parseMentions("@KANE: done? @LAMBERT's call")).toEqual(["KANE", "LAMBERT"]);
  expect(parseMentions("line one\n@PARKER")).toEqual(["PARKER"]);
});

test("parseMentions keeps crew ids whole", () => {
  expect(parseMentions("cc @vasquez-8e9b please")).toEqual(["vasquez-8e9b"]);
  expect(parseMentions("cc @vasquez-8e9b- and @hicks_2")).toEqual(["vasquez-8e9b", "hicks_2"]);
});

test("parseMentions skips email-like text and bare @", () => {
  expect(parseMentions("mail a@b.com or guy.l@example.org")).toEqual([]);
  expect(parseMentions("a lone @ sign, @@ and @-x")).toEqual([]);
  expect(parseMentions("see @host.example.com")).toEqual([]);
});

test("parseMentions drops duplicates, case-insensitively, keeping the first spelling", () => {
  expect(parseMentions("@DALLAS @dallas @Dallas @RIPLEY @DALLAS")).toEqual(["DALLAS", "RIPLEY"]);
});

test("parseMentions ignores @ inside code", () => {
  expect(parseMentions("run `npm i @types/bun` then ask @ASH")).toEqual(["ASH"]);
  expect(parseMentions("```\n@decorator\n```\n@ASH")).toEqual(["ASH"]);
});

test("splitMentions cuts text into plain and mention pieces, losing nothing", () => {
  const parts = splitMentions("hi @DALLAS, mail a@b.com");
  expect(parts).toEqual([
    { text: "hi " },
    { text: "@DALLAS", mention: "DALLAS" },
    { text: ", mail a@b.com" },
  ]);
  expect(splitMentions("no mentions")).toEqual([{ text: "no mentions" }]);
});

const agent = (sessionId: string, name: string, crew?: { id: string; name: string }) => ({ sessionId, name, ...(crew ? { crew } : {}) });

test("matchMentions matches name or crew id case-insensitively and reports the rest", () => {
  const dallas = agent("s1", "DALLAS", { id: "dallas-1a2b", name: "DALLAS" });
  const ripley = agent("s2", "RIPLEY", { id: "ripley-3f2a", name: "RIPLEY" });
  const r = matchMentions(["dallas", "ripley-3f2a", "BOB"], [dallas, ripley]);
  expect(r.hits).toEqual([{ mention: "dallas", agent: dallas }, { mention: "ripley-3f2a", agent: ripley }]);
  expect(r.unmatched).toEqual(["BOB"]);
});

test("matchMentions finds a desk whose name carries a session fragment, and one agent once", () => {
  const a = agent("d8c1ebad", "DALLAS d8c1", { id: "dallas-1a2b", name: "DALLAS" });
  const r = matchMentions(["DALLAS", "dallas-1a2b"], [a]);
  expect(r.hits).toEqual([{ mention: "DALLAS", agent: a }]);
  expect(r.unmatched).toEqual([]);
});
