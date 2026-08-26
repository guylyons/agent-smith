import { test, expect } from "bun:test";
import { parseConversation } from "../src/lib/conversation";

const L = (o: object) => JSON.stringify(o);

test("parses user prompts, assistant text, and tool activity in order", () => {
  const lines = [
    L({ type: "user", message: { content: [{ type: "text", text: "build the card" }] } }),
    L({ type: "assistant", message: { content: [{ type: "text", text: "On it." }, { type: "tool_use", name: "Edit", input: { file_path: "/x/card.twig" } }] } }),
    L({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }), // tool result, not a prompt
    L({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
  ];
  const msgs = parseConversation(lines);
  expect(msgs).toEqual([
    { role: "user", text: "build the card" },
    { role: "assistant", text: "On it." },
    { role: "tool", text: "editing card.twig" },
    { role: "assistant", text: "Done." },
  ]);
});

test("handles a bare-string user prompt and skips sidechain noise", () => {
  const lines = [
    L({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent chatter" }] } }),
    L({ type: "user", message: { content: "hello there" } }),
  ];
  expect(parseConversation(lines)).toEqual([{ role: "user", text: "hello there" }]);
});

test("keeps only the last max messages", () => {
  const lines = Array.from({ length: 10 }, (_, i) => L({ type: "user", message: { content: [{ type: "text", text: `m${i}` }] } }));
  const msgs = parseConversation(lines, 3);
  expect(msgs.map((m) => m.text)).toEqual(["m7", "m8", "m9"]);
});
