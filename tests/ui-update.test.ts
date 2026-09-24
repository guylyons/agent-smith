import { test, expect } from "bun:test";
import { watchUi } from "../src/ui/uiUpdate";

test("the first build seen is the one this page loaded: no reload, no toast", () => {
  const r = watchUi({}, { version: "aaa" });
  expect(r).toEqual({ seen: { loaded: "aaa", failedAt: undefined }, reload: false });
});

test("a failure from before this page opened is not toasted", () => {
  const r = watchUi({}, { version: "aaa", failed: { at: 5, error: "old" } });
  expect(r.failed).toBeUndefined();
  expect(r.seen.failedAt).toBe(5);
});

test("a new version after load offers a reload, and keeps offering it", () => {
  const first = watchUi({}, { version: "aaa" });
  const r = watchUi(first.seen, { version: "bbb" });
  expect(r.reload).toBe(true);
  expect(r.seen.loaded).toBe("aaa");
  expect(watchUi(r.seen, { version: "bbb" }).reload).toBe(true);
});

test("the same version, or no ui info at all, offers nothing", () => {
  const first = watchUi({}, { version: "aaa" });
  expect(watchUi(first.seen, { version: "aaa" }).reload).toBe(false);
  expect(watchUi(first.seen, undefined)).toEqual({ seen: first.seen, reload: false });
  expect(watchUi({}, undefined)).toEqual({ seen: {}, reload: false });
});

test("a new failure is toasted once", () => {
  const first = watchUi({}, { version: "aaa" });
  const r = watchUi(first.seen, { version: "aaa", failed: { at: 9, error: "Could not resolve" } });
  expect(r.failed).toBe("Could not resolve");
  expect(r.reload).toBe(false);
  expect(watchUi(r.seen, { version: "aaa", failed: { at: 9, error: "Could not resolve" } }).failed).toBeUndefined();
  expect(watchUi(r.seen, { version: "aaa", failed: { at: 12, error: "again" } }).failed).toBe("again");
});
