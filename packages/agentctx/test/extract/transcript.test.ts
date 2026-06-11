import { describe, expect, it } from "vitest";
import {
  MAP_REDUCE_CHUNK_TOKENS,
  TRUNCATED_HEAD_TOKENS,
  TRUNCATED_TAIL_TOKENS,
  parseTranscript,
  renderTurns,
  selectExtractionInput,
} from "../../src/extract/transcript.js";
import { CHARS_PER_TOKEN } from "../../src/hooks/tokens.js";

function jsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

describe("parseTranscript", () => {
  it("extracts developer and assistant text turns", () => {
    const turns = parseTranscript(
      jsonl([
        { type: "user", message: { role: "user", content: "switch to pnpm please" } },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Switching to pnpm." }] },
        },
      ]),
    );
    expect(turns).toEqual([
      { role: "developer", text: "switch to pnpm please" },
      { role: "assistant", text: "Switching to pnpm." },
    ]);
  });

  it("skips meta entries, tool results, and corrupt lines", () => {
    const turns = parseTranscript(
      [
        '{"truncated json',
        JSON.stringify({ type: "user", isMeta: true, message: { content: "meta noise" } }),
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        }),
        JSON.stringify({ type: "user", message: { content: "real prompt" } }),
        "",
      ].join("\n"),
    );
    expect(turns).toEqual([{ role: "developer", text: "real prompt" }]);
  });

  it("renders turns with role labels", () => {
    expect(
      renderTurns([
        { role: "developer", text: "hi" },
        { role: "assistant", text: "hello" },
      ]),
    ).toBe("Developer: hi\n\nAssistant: hello");
  });
});

describe("selectExtractionInput (SPEC §6 input policy)", () => {
  it("passes small transcripts through whole", () => {
    const input = selectExtractionInput("short transcript");
    expect(input).toEqual({ mode: "full", text: "short transcript" });
  });

  it("keeps first 3K + last 17K tokens for mid-size transcripts", () => {
    const rendered = "x".repeat(20_000 * CHARS_PER_TOKEN); // ~20K tokens
    const input = selectExtractionInput(rendered);
    expect(input.mode).toBe("truncated");
    if (input.mode !== "truncated") throw new Error("unreachable");
    const [head, tail] = input.text.split("\n\n[… transcript truncated …]\n\n");
    expect(head).toHaveLength(TRUNCATED_HEAD_TOKENS * CHARS_PER_TOKEN);
    expect(tail).toHaveLength(TRUNCATED_TAIL_TOKENS * CHARS_PER_TOKEN);
  });

  it("chunks >50K-token transcripts into 10K-token map-reduce pieces", () => {
    const tokens = 55_000;
    const rendered = "y".repeat(tokens * CHARS_PER_TOKEN);
    const input = selectExtractionInput(rendered);
    expect(input.mode).toBe("map-reduce");
    if (input.mode !== "map-reduce") throw new Error("unreachable");
    expect(input.chunks).toHaveLength(Math.ceil(tokens / MAP_REDUCE_CHUNK_TOKENS));
    expect(input.chunks[0]).toHaveLength(MAP_REDUCE_CHUNK_TOKENS * CHARS_PER_TOKEN);
    expect(input.chunks.join("")).toBe(rendered);
  });
});
