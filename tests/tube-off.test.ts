import { test, expect } from "bun:test";
import { tubeOffGate, type TubeOffState, type TubeOffPlay } from "../src/ui/sounds";

const fresh: TubeOffState = { busyUntil: 0, lastAt: -Infinity };

function run(times: number[], short = false): TubeOffPlay[] {
  let state = fresh;
  return times.map((t) => {
    const g = tubeOffGate(t, state, short);
    state = g.state;
    return g.play;
  });
}

test("five deaths 0.4s apart play one full sound, then only clicks", () => {
  expect(run([10, 10.4, 10.8, 11.2, 11.6])).toEqual(["full", "click", "click", "click", "click"]);
});

test("deaths in one snapshot play once with no extra click", () => {
  expect(run([5, 5, 5.1])).toEqual(["full", "none", "none"]);
});

test("a death after the sound has finished plays normally", () => {
  expect(run([1, 2.5])).toEqual(["full", "full"]);
  expect(run([1, 2.4])).toEqual(["full", "click"]);
});

test("the short version only blocks for its 0.3s", () => {
  expect(run([1, 1.3], true)).toEqual(["full", "full"]);
  expect(run([1, 1.29], true)).toEqual(["full", "click"]);
});

test("a click holds the gate only briefly; quiet after it lets the full sound back", () => {
  // click at 2.4 holds until 2.9
  expect(run([1, 2.4, 2.8, 3.3])).toEqual(["full", "click", "click", "full"]);
});

test("the first death ever plays, even at time 0", () => {
  expect(run([0])).toEqual(["full"]);
});
