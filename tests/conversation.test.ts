import { test, expect } from "bun:test";
import { parseConversation, findPendingQuestion } from "../src/lib/conversation";

const L = (o: object) => JSON.stringify(o);

test("findPendingQuestion surfaces an unanswered AskUserQuestion", () => {
  const q = { header: "Next", question: "What next?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] };
  const lines = [
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "AskUserQuestion", input: { questions: [q] } }] } }),
  ];
  const p = findPendingQuestion(lines)!;
  expect(p.questions[0].question).toBe("What next?");
  expect(p.questions[0].options.map((o) => o.label)).toEqual(["A", "B"]);
});

test("findPendingQuestion returns null once the question is answered", () => {
  const lines = [
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "AskUserQuestion", input: { questions: [{ question: "q", options: [{ label: "A" }] }] } }] } }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "answered: A" }] } }),
  ];
  expect(findPendingQuestion(lines)).toBeNull();
});

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

test("reformats a slash-command invocation instead of showing raw XML", () => {
  const lines = [
    L({ type: "user", message: { content: "<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>" } }),
  ];
  expect(parseConversation(lines)).toEqual([{ role: "tool", text: "/clear" }]);
});

test("drops local-command-stdout noise", () => {
  const lines = [
    L({ type: "user", message: { content: "<local-command-stdout></local-command-stdout>" } }),
    L({ type: "user", message: { content: [{ type: "text", text: "real prompt" }] } }),
  ];
  expect(parseConversation(lines)).toEqual([{ role: "user", text: "real prompt" }]);
});

test("summarizes a background task-notification as an activity line", () => {
  const tn = '<task-notification>\n<task-id>b08iqj8lz</task-id>\n<status>killed</status>\n<summary>Background command "Restart server" was stopped</summary>\n</task-notification>';
  const lines = [L({ type: "user", message: { content: tn } })];
  expect(parseConversation(lines)).toEqual([
    { role: "tool", text: 'Background command "Restart server" was stopped' },
  ]);
});

test("keeps only the last max messages", () => {
  const lines = Array.from({ length: 10 }, (_, i) => L({ type: "user", message: { content: [{ type: "text", text: `m${i}` }] } }));
  const msgs = parseConversation(lines, 3);
  expect(msgs.map((m) => m.text)).toEqual(["m7", "m8", "m9"]);
});
