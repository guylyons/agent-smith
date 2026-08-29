import { test, expect } from "bun:test";
import { signalDying, subscribeDying, dyingMs } from "../src/ui/dying";

test("a stop announces the dying session to every subscriber until it unsubscribes", () => {
  const seen: string[] = [];
  const off = subscribeDying((id) => seen.push(id));

  signalDying("sess-a");
  signalDying("sess-b");
  off();
  signalDying("sess-c"); // nobody listening: dropped

  expect(seen).toEqual(["sess-a", "sess-b"]);
});

test("the hold matches the full animation, but shortens to the plain fade under reduced motion", () => {
  const real = globalThis.matchMedia;
  try {
    // no matchMedia at all (or no preference): the full 1.5s glitch plays
    // @ts-expect-error - deleting an optional DOM global in the test env
    delete globalThis.matchMedia;
    expect(dyingMs()).toBe(1500);

    globalThis.matchMedia = ((q: string) => ({ matches: q.includes("reduce") })) as typeof globalThis.matchMedia;
    expect(dyingMs()).toBe(300);

    globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof globalThis.matchMedia;
    expect(dyingMs()).toBe(1500);
  } finally {
    if (real) globalThis.matchMedia = real; else { // @ts-expect-error - restore "absent"
      delete globalThis.matchMedia; }
  }
});
