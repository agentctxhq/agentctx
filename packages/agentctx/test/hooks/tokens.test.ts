import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, estimateTokens, truncateToTokens } from "../../src/hooks/tokens.js";

describe("estimateTokens", () => {
  it("rounds up at ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(6000))).toBe(1500);
  });
});

describe("truncateToTokens", () => {
  it("returns short text unchanged", () => {
    expect(truncateToTokens("hello", 10)).toBe("hello");
  });

  it("never exceeds the budget in characters", () => {
    const text = "word ".repeat(1000);
    for (const budget of [10, 100, 500]) {
      expect(truncateToTokens(text, budget).length).toBeLessThanOrEqual(budget * CHARS_PER_TOKEN);
    }
  });

  it("cuts at a word or line boundary and appends an ellipsis", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const cut = truncateToTokens(text, 5);
    expect(cut.endsWith("…")).toBe(true);
    expect(text.startsWith(cut.slice(0, cut.length - 2))).toBe(true);
  });

  it("returns empty for a budget too small to carry the marker", () => {
    expect(truncateToTokens("something long enough", 0)).toBe("");
  });
});
