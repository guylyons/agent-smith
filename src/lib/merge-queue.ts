// A serial queue, keyed by string. Jobs sharing a key run strictly one at a
// time, in the order they were enqueued; jobs on different keys run
// independently. This is what stops two merges into the same checkout from
// tripping over each other — the key is the repo root, so the shared trunk is
// only ever touched by one merge at a time.
//
// In-process only: a single Bun server owns the checkout, so an in-memory
// chain is the whole story. No file locks, no cross-process coordination.

/** The tail of each key's chain — a promise that settles when the last job
 *  enqueued so far has finished. Errors are swallowed here so one failed job
 *  never breaks the chain for the jobs behind it. */
const tails = new Map<string, Promise<void>>();

/** Running + waiting jobs per key, so callers can see how deep the line is. */
const counts = new Map<string, number>();

/** How many jobs are running or waiting on this key (0 = idle). */
export function pending(key: string): number {
  return counts.get(key) ?? 0;
}

/**
 * Run `job` with exclusive access to `key`. Resolves (or rejects) with whatever
 * `job` does; a rejection is the caller's to handle and does not wedge the key —
 * the next job in line still runs.
 */
export function runExclusive<T>(key: string, job: () => Promise<T>): Promise<T> {
  counts.set(key, (counts.get(key) ?? 0) + 1);

  // Wait for everyone ahead of us (the current tail, which never rejects), then
  // take our turn.
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => job());

  // The new tail: our run, with its result and error swallowed, so the next
  // job chains onto a promise that only ever resolves.
  const tail = run.then(() => {}, () => {});
  tails.set(key, tail);

  // Book-keeping: when our turn is over, drop our count and forget the key once
  // the line is empty (leaving a stale tail behind is harmless but unbounded).
  void tail.then(() => {
    const n = (counts.get(key) ?? 1) - 1;
    if (n <= 0) {
      counts.delete(key);
      if (tails.get(key) === tail) tails.delete(key);
    } else {
      counts.set(key, n);
    }
  });

  return run;
}
