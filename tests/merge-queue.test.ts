import { test, expect } from "bun:test";
import { runExclusive, pending } from "../src/lib/merge-queue";

/** A promise you resolve by hand, so a test can hold a job "running". */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("jobs on the same key run one at a time, in the order they arrived", async () => {
  const order: string[] = [];
  const running: string[] = [];
  let maxConcurrent = 0;

  const job = (id: string) => async () => {
    running.push(id);
    maxConcurrent = Math.max(maxConcurrent, running.length);
    await tick();
    order.push(id);
    running.pop();
  };

  await Promise.all([
    runExclusive("root", job("a")),
    runExclusive("root", job("b")),
    runExclusive("root", job("c")),
  ]);

  expect(order).toEqual(["a", "b", "c"]);
  expect(maxConcurrent).toBe(1);
});

test("different keys run concurrently — one key never blocks another", async () => {
  const a = deferred();
  const b = deferred();
  let aStarted = false;
  let bStarted = false;

  const pa = runExclusive("root-a", async () => { aStarted = true; await a.promise; });
  const pb = runExclusive("root-b", async () => { bStarted = true; await b.promise; });

  await tick();
  // Neither has finished, yet both are running — the keys are independent.
  expect(aStarted).toBe(true);
  expect(bStarted).toBe(true);

  a.resolve(); b.resolve();
  await Promise.all([pa, pb]);
});

test("runExclusive resolves with the job's return value", async () => {
  const value = await runExclusive("root", async () => 42);
  expect(value).toBe(42);
});

test("a throwing job rejects its own caller but does not wedge the key", async () => {
  const boom = runExclusive("root", async () => { throw new Error("boom"); });
  await expect(boom).rejects.toThrow("boom");

  // The next job on the same key still runs.
  const after = await runExclusive("root", async () => "ok");
  expect(after).toBe("ok");
});

test("pending reflects running + waiting, and returns to zero when drained", async () => {
  const g1 = deferred();
  const g2 = deferred();

  expect(pending("root")).toBe(0);

  const p1 = runExclusive("root", async () => { await g1.promise; });
  const p2 = runExclusive("root", async () => { await g2.promise; });
  await tick();

  // One running, one waiting.
  expect(pending("root")).toBe(2);

  g1.resolve();
  await p1;
  await tick();
  expect(pending("root")).toBe(1);

  g2.resolve();
  await p2;
  await tick();
  expect(pending("root")).toBe(0);
});
