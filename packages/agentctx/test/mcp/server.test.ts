import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveMcp } from "../../src/mcp/server.js";
import { type ToolContext, toolDefinitions } from "../../src/mcp/tools.js";
import { insertRecord } from "../../src/storage/records.js";
import { VERSION } from "../../src/version.js";
import { type TempDb, openTempDb } from "../storage/helpers.js";

const PROJECT = "server-test-project";

interface Harness {
  send: (message: unknown) => void;
  sendRaw: (line: string) => void;
  close: () => Promise<void>;
  responses: () => unknown[];
}

let tmp: TempDb;
let harness: Harness;

function startServer(): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const context: ToolContext = { db: tmp.db, projectId: PROJECT, cwd: "/tmp" };
  const done = serveMcp({ input, output, context, tools: toolDefinitions() });

  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
  });

  return {
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    sendRaw: (line) => input.write(`${line}\n`),
    close: async () => {
      input.end();
      await done;
    },
    responses: () =>
      buffered
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line)),
  };
}

beforeEach(() => {
  tmp = openTempDb();
  harness = startServer();
});

afterEach(() => {
  tmp.cleanup();
});

async function roundTrip(...messages: unknown[]): Promise<unknown[]> {
  for (const message of messages) {
    harness.send(message);
  }
  await harness.close();
  return harness.responses();
}

describe("initialize", () => {
  it("negotiates a known protocol version and reports server info", async () => {
    const [response] = await roundTrip({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "agentctx", version: VERSION },
      },
    });
  });

  it("falls back to the default version for an unknown one", async () => {
    const [response] = await roundTrip({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(response).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  });
});

describe("tools/list", () => {
  it("lists exactly the seven tools with schemas", async () => {
    const [response] = await roundTrip({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const { tools } = (response as { result: { tools: Array<Record<string, unknown>> } }).result;
    expect(tools.map((t) => t.name)).toEqual([
      "ctx_search",
      "ctx_get",
      "ctx_record",
      "ctx_supersede",
      "ctx_project",
      "ctx_related",
      "ctx_sync_claudemd",
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });
});

describe("tools/call", () => {
  it("runs a tool and returns its JSON payload as text content", async () => {
    insertRecord(tmp.db, {
      projectId: PROJECT,
      type: "decision",
      title: "Stdio transport",
      body: "MCP over stdio, no daemon",
      source: "cli",
    });

    const [response] = await roundTrip({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ctx_search", arguments: { query: "stdio transport" } },
    });

    const result = (response as { result: { content: Array<{ text: string }>; isError: boolean } })
      .result;
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].title).toBe("Stdio transport");
  });

  it("returns isError with the structured payload for tool failures", async () => {
    const [response] = await roundTrip({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ctx_search", arguments: {} },
    });
    const result = (response as { result: { content: Array<{ text: string }>; isError: boolean } })
      .result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toHaveProperty("error");
  });

  it("returns isError for an unknown tool name", async () => {
    const [response] = await roundTrip({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ctx_nope", arguments: {} },
    });
    const result = (response as { result: { isError: boolean } }).result;
    expect(result.isError).toBe(true);
  });

  it("rejects a call without a tool name as invalid params", async () => {
    const [response] = await roundTrip({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {},
    });
    expect(response).toMatchObject({ id: 6, error: { code: -32602 } });
  });
});

describe("protocol edges", () => {
  it("answers ping", async () => {
    const [response] = await roundTrip({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(response).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("responds with a parse error to malformed JSON", async () => {
    harness.sendRaw("{not json");
    await harness.close();
    expect(harness.responses()[0]).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("ignores notifications but rejects unknown requests", async () => {
    const responses = await roundTrip(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: {} },
      { jsonrpc: "2.0", id: 8, method: "resources/list" },
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: 8, error: { code: -32601 } });
  });

  it("rejects non-request payloads without crashing", async () => {
    const responses = await roundTrip(42, { jsonrpc: "1.0", id: 9, method: "ping" });
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response).toMatchObject({ error: { code: -32600 } });
    }
  });
});
