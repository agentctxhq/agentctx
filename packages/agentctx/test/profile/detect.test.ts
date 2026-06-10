import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROFILE_TITLES,
  detectProjectProfile,
  refreshProjectProfile,
} from "../../src/profile/detect.js";
import { listRecords } from "../../src/storage/records.js";
import { BODY_MAX_CHARS } from "../../src/storage/types.js";
import { type TempDb, openTempDb } from "../storage/helpers.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentctx-detect-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePackageJson(pkg: unknown): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2), { encoding: "utf8" });
}

function entryByTitle(title: string) {
  const entry = detectProjectProfile(dir).find((e) => e.title === title);
  expect(entry).toBeDefined();
  return entry as { title: string; body: string };
}

describe("detectProjectProfile", () => {
  it("returns nothing for an unrecognizable directory", () => {
    expect(detectProjectProfile(dir)).toEqual([]);
  });

  it("detects stack, commands, and entry points from package.json", () => {
    writePackageJson({
      name: "demo",
      bin: { demo: "./dist/cli.js" },
      main: "./dist/index.js",
      engines: { node: ">=20.0.0" },
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run",
        obscure: "echo hi",
      },
      dependencies: { "better-sqlite3": "^12.0.0" },
      devDependencies: { typescript: "^5.7.0", vitest: "^2.0.0" },
    });
    writeFileSync(join(dir, "package-lock.json"), "{}", { encoding: "utf8" });

    const stack = entryByTitle(PROFILE_TITLES.stack).body;
    expect(stack).toContain("Node.js (node >=20.0.0)");
    expect(stack).toContain("TypeScript");
    expect(stack).toContain("better-sqlite3");
    expect(stack).toContain("Vitest");
    expect(stack).toContain("Package manager: npm");

    const commands = entryByTitle(PROFILE_TITLES.commands).body;
    expect(commands).toContain("npm run build — tsc -p tsconfig.json");
    expect(commands).toContain("npm run test — vitest run");
    // well-known scripts come before alphabetized extras
    expect(commands.indexOf("npm run test")).toBeLessThan(commands.indexOf("obscure"));

    const entryPoints = entryByTitle(PROFILE_TITLES.entryPoints).body;
    expect(entryPoints).toContain("bin demo: ./dist/cli.js");
    expect(entryPoints).toContain("main: ./dist/index.js");
  });

  it("uses the package manager from lockfiles for command prefixes", () => {
    writePackageJson({ scripts: { test: "vitest run" } });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "", { encoding: "utf8" });

    const commands = entryByTitle(PROFILE_TITLES.commands).body;
    expect(commands).toContain("pnpm run test");
  });

  it("detects workspaces and non-Node ecosystems", () => {
    writePackageJson({ workspaces: ["packages/*"] });
    writeFileSync(join(dir, "Cargo.toml"), "[package]", { encoding: "utf8" });
    writeFileSync(join(dir, "pyproject.toml"), "[project]", { encoding: "utf8" });

    const stack = entryByTitle(PROFILE_TITLES.stack).body;
    expect(stack).toContain("workspaces (packages/*)");
    expect(stack).toContain("Rust");
    expect(stack).toContain("Python");
  });

  it("survives a malformed package.json", () => {
    writeFileSync(join(dir, "package.json"), "{ nope", { encoding: "utf8" });
    expect(detectProjectProfile(dir)).toEqual([]);
  });

  it("clips bodies to the record size limit", () => {
    writePackageJson({
      scripts: { build: "x".repeat(BODY_MAX_CHARS) },
    });
    const commands = entryByTitle(PROFILE_TITLES.commands).body;
    expect(commands.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
  });
});

describe("refreshProjectProfile", () => {
  let tmp: TempDb;
  const projectId = "p".repeat(64);

  beforeEach(() => {
    tmp = openTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("creates records on first run and skips unchanged on re-run", () => {
    const entries = [
      { title: PROFILE_TITLES.stack, body: "Runtime: Node.js" },
      { title: PROFILE_TITLES.commands, body: "npm run test — vitest" },
    ];

    const first = refreshProjectProfile(tmp.db, projectId, entries);
    expect(first.created.sort()).toEqual([PROFILE_TITLES.commands, PROFILE_TITLES.stack].sort());

    const second = refreshProjectProfile(tmp.db, projectId, entries);
    expect(second.created).toEqual([]);
    expect(second.refreshed).toEqual([]);
    expect(second.unchanged).toHaveLength(2);
    // no churn: still exactly two current records
    expect(listRecords(tmp.db, projectId, { type: "profile" })).toHaveLength(2);
  });

  it("supersedes by key when a value changes (SPEC §3.5 rule-based refresh)", () => {
    refreshProjectProfile(tmp.db, projectId, [
      { title: PROFILE_TITLES.stack, body: "Runtime: Node.js" },
    ]);
    const result = refreshProjectProfile(tmp.db, projectId, [
      { title: PROFILE_TITLES.stack, body: "Runtime: Node.js\nLanguage: TypeScript" },
    ]);

    expect(result.refreshed).toEqual([PROFILE_TITLES.stack]);

    const current = listRecords(tmp.db, projectId, { type: "profile" });
    expect(current).toHaveLength(1);
    expect(current[0]?.body).toContain("TypeScript");

    const all = listRecords(tmp.db, projectId, { type: "profile", includeSuperseded: true });
    expect(all).toHaveLength(2);
    const superseded = all.find((r) => r.supersededAt !== null);
    expect(superseded?.supersededBy).toBe(current[0]?.id);
  });
});
