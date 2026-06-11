import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendInjectedIds, dedupFilePath, readInjectedIds } from "../../src/hooks/dedup.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentctx-dedup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dedupFilePath", () => {
  it("uses the session id in the file name", () => {
    expect(dedupFilePath("/tmp", "abc-123")).toBe(join("/tmp", "agentctx-abc-123.json"));
  });

  it("sanitizes hostile session ids so they cannot escape the temp dir", () => {
    const path = dedupFilePath(dir, "../../etc/passwd");
    expect(resolve(path).startsWith(resolve(dir))).toBe(true);
  });
});

describe("read/append round trip", () => {
  it("missing file reads as empty (degrades to re-injection)", () => {
    expect(readInjectedIds(join(dir, "nope.json")).size).toBe(0);
  });

  it("corrupt file reads as empty, then is repaired by the next append", () => {
    const path = dedupFilePath(dir, "s1");
    writeFileSync(path, "{not json[", "utf8");
    expect(readInjectedIds(path).size).toBe(0);

    appendInjectedIds(path, ["a", "b"]);
    expect([...readInjectedIds(path)].sort()).toEqual(["a", "b"]);
  });

  it("appends merge with existing ids", () => {
    const path = dedupFilePath(dir, "s2");
    appendInjectedIds(path, ["a"]);
    appendInjectedIds(path, ["b", "a"]);
    expect([...readInjectedIds(path)].sort()).toEqual(["a", "b"]);
  });

  it("non-array JSON content reads as empty", () => {
    const path = dedupFilePath(dir, "s3");
    writeFileSync(path, JSON.stringify({ injected: ["a"] }), "utf8");
    expect(readInjectedIds(path).size).toBe(0);
  });
});
