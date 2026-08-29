import { test, expect } from "bun:test";
import { isDictatable, spliceTranscript, micPosition, MIC_SIZE, MIC_GAP } from "../src/lib/dictation";

/** A structural stand-in for a DOM node — all `isDictatable` ever looks at. */
function field(tagName: string, o: { type?: string; disabled?: boolean; readOnly?: boolean } = {}) {
  return { tagName, ...o };
}

// ---- WHICH FIELDS GET A MIC ----------------------------------------------

test("a textarea takes dictation", () => {
  expect(isDictatable(field("TEXTAREA"))).toBe(true);
});

test("a plain text input takes dictation", () => {
  expect(isDictatable(field("INPUT", { type: "text" }))).toBe(true);
});

test("an input with no type at all is a text input, so it takes dictation", () => {
  expect(isDictatable(field("INPUT"))).toBe(true);
});

test("search, url and tel inputs take dictation", () => {
  for (const type of ["search", "url", "tel"]) {
    expect(isDictatable(field("INPUT", { type }))).toBe(true);
  }
});

test("an email input does not take dictation \u2014 browsers forbid selection on it", () => {
  // No cursor means nowhere to splice the transcript, so the mic stays away
  // rather than dropping words in the wrong place.
  expect(isDictatable(field("INPUT", { type: "email" }))).toBe(false);
});

test("file, range and password inputs do not take dictation", () => {
  for (const type of ["file", "range", "password", "checkbox", "color", "date", "number"]) {
    expect(isDictatable(field("INPUT", { type }))).toBe(false);
  }
});

test("a disabled field does not take dictation", () => {
  expect(isDictatable(field("TEXTAREA", { disabled: true }))).toBe(false);
});

test("a read-only field does not take dictation", () => {
  expect(isDictatable(field("INPUT", { type: "text", readOnly: true }))).toBe(false);
});

test("a non-field element does not take dictation", () => {
  expect(isDictatable(field("DIV"))).toBe(false);
  expect(isDictatable(field("BUTTON"))).toBe(false);
});

test("nothing focused takes no dictation", () => {
  expect(isDictatable(null)).toBe(false);
});

// ---- WHERE THE TRANSCRIPT LANDS ------------------------------------------

test("dictating into an empty field is just the transcript", () => {
  expect(spliceTranscript("", 0, 0, "hello there")).toEqual({ value: "hello there", cursor: 11 });
});

test("dictating at the end of a word separates it with a space", () => {
  expect(spliceTranscript("hello", 5, 5, "there")).toEqual({ value: "hello there", cursor: 11 });
});

test("dictating after existing whitespace does not double the space", () => {
  expect(spliceTranscript("hello ", 6, 6, "there")).toEqual({ value: "hello there", cursor: 11 });
});

test("dictating in front of existing text separates it with a space", () => {
  expect(spliceTranscript("world", 0, 0, "hello")).toEqual({ value: "hello world", cursor: 5 });
});

test("dictating replaces the selected text", () => {
  expect(spliceTranscript("hello world", 6, 11, "there")).toEqual({ value: "hello there", cursor: 11 });
});

test("the cursor lands at the end of what was just dictated", () => {
  const r = spliceTranscript("a  z", 2, 2, "mid");
  expect(r.value).toBe("a mid z");
  expect(r.value.slice(0, r.cursor)).toBe("a mid");
});

test("re-splicing the same anchor replaces the interim text rather than stacking it", () => {
  // How live interim results work: each update re-splices the whole running
  // transcript into the ORIGINAL value, so the field never accumulates drafts.
  const first = spliceTranscript("note: ", 6, 6, "buy");
  const second = spliceTranscript("note: ", 6, 6, "buy milk");
  expect(first.value).toBe("note: buy");
  expect(second.value).toBe("note: buy milk");
});

// ---- WHERE THE MIC SITS --------------------------------------------------

test("the mic tucks inside the field's right edge", () => {
  const p = micPosition({ left: 100, top: 50, width: 300, height: 200 });
  expect(p.left).toBe(100 + 300 - MIC_SIZE - MIC_GAP);
});

test("on a tall textarea the mic rides near the top", () => {
  const p = micPosition({ left: 0, top: 50, width: 300, height: 200 });
  expect(p.top).toBe(50 + MIC_GAP);
});

test("on a short input the mic is vertically centred instead of hugging the top", () => {
  const height = MIC_SIZE + 6;
  const p = micPosition({ left: 0, top: 50, width: 300, height });
  expect(p.top).toBe(50 + (height - MIC_SIZE) / 2);
});
