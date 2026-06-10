import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("package surface", () => {
  it("exposes the current version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
