// tests/session-end-confirm.test.ts — the rule behind "Moving to Done ends
// RIPLEY's session." (src/ui/sessionEnd.ts): which moves stop to ask, and that
// the move waits for the answer. The dialog itself was checked in the browser.
import { test, expect } from "bun:test";
import { defaultBoard, addColumn, addCard, assignCard, type Board } from "../src/lib/board";
import { endsLiveSession, guardSessionEnd, subscribeEndConfirm, type EndRequest } from "../src/ui/sessionEnd";

const ripley = { sessionId: "s1", name: "RIPLEY", crew: { id: "ripley-c8e7", name: "RIPLEY" } };

// A stock board plus "Merged" after Done, with one card assigned to RIPLEY in `col`.
function setup(col = "in-progress"): { b: Board; id: string; merged: string } {
  let b = addColumn(addCard(defaultBoard(), col, "t"), "Merged");
  const id = b.cards[b.cards.length - 1]!.id;
  b = assignCard(b, id, { id: "s1", name: "RIPLEY", crew: "ripley-c8e7" });
  return { b, id, merged: b.columns[4]!.id };
}

test("endsLiveSession: into Done or past it, with the agent running, names the agent", () => {
  const { b, id, merged } = setup();
  expect(endsLiveSession(b, [ripley], id, "done")).toBe("RIPLEY");
  expect(endsLiveSession(b, [ripley], id, merged)).toBe("RIPLEY");
});

test("endsLiveSession: after a /clear the agent is matched by crew id", () => {
  const { b, id } = setup();
  expect(endsLiveSession(b, [{ ...ripley, sessionId: "s2" }], id, "done")).toBe("RIPLEY");
});

test("endsLiveSession: harmless moves, ended sessions and unassigned cards don't ask", () => {
  const { b, id } = setup();
  expect(endsLiveSession(b, [ripley], id, "review")).toBeNull();
  expect(endsLiveSession(b, [], id, "done")).toBeNull();
  expect(endsLiveSession(assignCard(b, id, null), [ripley], id, "done")).toBeNull();
  // Already finished: moving on to Merged ends nothing new.
  const { b: d, id: did, merged } = setup("done");
  expect(endsLiveSession(d, [ripley], did, merged)).toBeNull();
});

test("guardSessionEnd: a harmless move goes straight through", () => {
  const { b, id } = setup();
  let moved = 0;
  guardSessionEnd(b, [ripley], id, "review", () => moved++);
  expect(moved).toBe(1);
});

test("guardSessionEnd: a move that ends the agent waits for yes, and cancel keeps it", () => {
  const { b, id } = setup();
  const asks: EndRequest[] = [];
  const off = subscribeEndConfirm((r) => asks.push(r));
  let moved = 0;
  guardSessionEnd(b, [ripley], id, "done", () => moved++);
  expect(moved).toBe(0);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ cardId: id, agent: "RIPLEY", column: "Done" });
  asks[0]!.answer(false);
  expect(moved).toBe(0);
  guardSessionEnd(b, [ripley], id, "done", () => moved++);
  asks[1]!.answer(true);
  expect(moved).toBe(1);
  off();
});

test("guardSessionEnd: with no dialog to ask, it does not move", () => {
  const { b, id } = setup();
  let moved = 0;
  guardSessionEnd(b, [ripley], id, "done", () => moved++);
  expect(moved).toBe(0);
});
