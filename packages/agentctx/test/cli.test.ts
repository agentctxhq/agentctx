import { describe, expect, it } from "vitest";
import { describeError } from "../src/errors.js";
import { VERSION } from "../src/index.js";

describe("package surface", () => {
  it("exposes the current version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("describes Error and non-Error throwables consistently", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain failure")).toBe("plain failure");
  });
});
