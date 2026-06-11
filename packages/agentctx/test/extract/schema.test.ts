import { describe, expect, it } from "vitest";
import { parseExtraction } from "../../src/extract/schema.js";

const VALID = {
  decisions: [
    {
      what: "Use Postgres LISTEN/NOTIFY for the job queue",
      rationale: "One less service",
      supersedes: null,
      confidence: "explicit",
    },
  ],
  preferences: [
    { category: "style", rule: "Prefers arrow functions", confidence: "inferred", scope: "global" },
  ],
  conventions: [
    { scope: "project", convention: "Handlers return Result<T, E>", confidence: "explicit" },
  ],
  active_work: {
    current_task: "Migrating auth middleware",
    blockers: ["expired creds"],
    next_steps: ["rotate tokens"],
    open_questions: [],
  },
  gotchas: [{ pattern: "Mocks leak file handles", why_it_matters: "EMFILE in CI" }],
  flush_ok: false,
};

describe("parseExtraction (SPEC §6 schema validation)", () => {
  it("parses a fully valid result", () => {
    const result = parseExtraction(JSON.stringify(VALID));
    expect(result).not.toBeNull();
    expect(result?.decisions).toHaveLength(1);
    expect(result?.preferences[0]?.scope).toBe("global");
    expect(result?.conventions[0]?.confidence).toBe("explicit");
    expect(result?.activeWork?.currentTask).toBe("Migrating auth middleware");
    expect(result?.gotchas[0]?.whyItMatters).toBe("EMFILE in CI");
    expect(result?.flushOk).toBe(false);
    expect(result?.droppedEntries).toBe(0);
  });

  it("drops schema-failing entries and keeps the rest", () => {
    const result = parseExtraction(
      JSON.stringify({
        ...VALID,
        decisions: [
          ...VALID.decisions,
          { what: "", rationale: null, supersedes: null, confidence: "explicit" }, // empty what
          { what: "no confidence", rationale: null, supersedes: null, confidence: "certain" },
        ],
        preferences: [
          ...VALID.preferences,
          { category: "vibes", rule: "invalid category", confidence: "inferred", scope: "project" },
        ],
        gotchas: [...VALID.gotchas, { pattern: "missing why" }],
      }),
    );
    expect(result?.decisions).toHaveLength(1);
    expect(result?.preferences).toHaveLength(1);
    expect(result?.gotchas).toHaveLength(1);
    expect(result?.droppedEntries).toBe(4);
  });

  it("handles markdown-fenced output", () => {
    const result = parseExtraction(`\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``);
    expect(result?.decisions).toHaveLength(1);
  });

  it("parses flush_ok with empty fields", () => {
    const result = parseExtraction(JSON.stringify({ flush_ok: true }));
    expect(result?.flushOk).toBe(true);
    expect(result?.decisions).toEqual([]);
    expect(result?.activeWork).toBeNull();
  });

  it("returns null for non-JSON and non-object output", () => {
    expect(parseExtraction("I could not extract anything, sorry!")).toBeNull();
    expect(parseExtraction('["an", "array"]')).toBeNull();
  });

  it("treats empty active_work as absent", () => {
    const result = parseExtraction(
      JSON.stringify({
        ...VALID,
        active_work: { current_task: "", blockers: [], next_steps: [], open_questions: [] },
      }),
    );
    expect(result?.activeWork).toBeNull();
  });
});
