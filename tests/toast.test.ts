import { test, expect } from "bun:test";
import { toast, subscribeToasts } from "../src/ui/toast";

test("a toast carries an optional action its subscriber can run", () => {
  const seen: { text: string; label?: string }[] = [];
  let ran = 0;
  const off = subscribeToasts((t) => seen.push({ text: t.text, label: t.action?.label }));

  toast("Deleted \"spec\"", { label: "UNDO", run: () => { ran++; } });
  toast("plain");

  expect(seen).toEqual([
    { text: 'Deleted "spec"', label: "UNDO" },
    { text: "plain", label: undefined },
  ]);
  off();
});

test("running a toast's action invokes the callback exactly once per toast", () => {
  let ran = 0;
  let captured: (() => void) | undefined;
  const off = subscribeToasts((t) => { if (t.action) captured = t.action.run; });

  toast("Deleted", { label: "UNDO", run: () => { ran++; } });
  captured?.();

  expect(ran).toBe(1);
  off();
});
