import { test, expect } from "bun:test";
import { fmtTokens } from "../src/ui/UsageMeter";

test("fmtTokens renders millions, thousands, and small counts", () => {
  expect(fmtTokens(15_000_000)).toBe("15M");
  expect(fmtTokens(14_951_815)).toBe("15M");
  expect(fmtTokens(2_680_000)).toBe("2.7M");
  expect(fmtTokens(152_300)).toBe("152K");
  expect(fmtTokens(980)).toBe("980");
  expect(fmtTokens(0)).toBe("0");
});
