// tests/font.test.ts — the UI font picker: which face a stored choice resolves
// to, and what it writes onto <html>.
import { test, expect, beforeEach } from "bun:test";
import { FONTS, FONT_DEFAULT, FONT_THEME, loadFont, fontStack, applyFont, KEYS } from "../src/ui/settings";

const store = new Map<string, string>();
// @ts-expect-error minimal localStorage stand-in for the setting readers
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
};
const props = new Map<string, string>();
// minimal document stand-in: applyFont only touches the root element's style
globalThis.document = { documentElement: { style: {
  setProperty: (k: string, v: string) => { props.set(k, v); },
  removeProperty: (k: string) => { props.delete(k); return ""; },
} } } as unknown as Document;

beforeEach(() => { store.clear(); props.clear(); });

test("a fresh install gets Source Code Pro", () => {
  expect(FONT_DEFAULT).toBe("source-code-pro");
  expect(loadFont()).toBe("source-code-pro");
});

test("a stored choice survives; junk in storage falls back to the default", () => {
  store.set(KEYS.font, "jetbrains-mono");
  expect(loadFont()).toBe("jetbrains-mono");
  store.set(KEYS.font, "comic-sans");
  expect(loadFont()).toBe(FONT_DEFAULT);
});

test("every font names its face first and ends on a monospace fallback", () => {
  for (const f of FONTS) {
    if (f.id === FONT_THEME) continue;
    const stack = fontStack(f.id)!;
    expect(stack.startsWith(`"${f.family}"`)).toBe(true);
    expect(stack.endsWith("monospace")).toBe(true);
  }
});

test("picking a font sets the body and code faces; THEME hands them back", () => {
  applyFont("fira-code");
  expect(props.get("--mono")).toContain('"Fira Code"');
  expect(props.get("--code")).toContain('"Fira Code"');
  applyFont(FONT_THEME);
  expect(props.has("--mono")).toBe(false);
  expect(props.has("--code")).toBe(false);
});
