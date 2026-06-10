import { describe, expect, it } from "vitest";
import { ulid } from "../../src/storage/ulid.js";

const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

describe("ulid", () => {
  it("produces 26-char Crockford base32 ids", () => {
    expect(ulid()).toMatch(ULID_PATTERN);
  });

  it("is unique across many generations", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => ulid()));
    expect(ids.size).toBe(10_000);
  });

  it("sorts lexicographically by creation time", () => {
    const early = ulid(1_000_000_000_000);
    const late = ulid(2_000_000_000_000);
    expect(early < late).toBe(true);
  });

  it("is monotonic within the same millisecond", () => {
    const now = Date.now();
    const ids = Array.from({ length: 100 }, () => ulid(now));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(100);
  });
});
