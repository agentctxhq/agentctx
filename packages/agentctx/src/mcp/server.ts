/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0 (ADR-001/008).
 *
 * Hand-rolled rather than `@modelcontextprotocol/sdk` — the SDK brings zod
 * and a transport framework we don't need for one stdio server with seven
 * tools, and v0.1 targets zero runtime dependencies beyond better-sqlite3
 * (SPEC §2.2). The surface we implement is the subset Claude Code speaks:
 * initialize, notifications/initialized, ping, tools/list, tools/call.
 *
 * Protocol errors (malformed JSON, unknown methods) use JSON-RPC error
 * responses; tool execution failures are MCP tool results with
 * `isError: true` carrying the SPEC §5 `{error, degraded?}` payload —
 * nothing throws raw into the channel.
 */
import { createInterface } from "node:readline";
import { isJsonObject } from "../claude/json-file.js";
import { VERSION } from "../version.js";
import { type ToolContext, type ToolDefinition, callTool } from "./tools.js";

/** Protocol revisions we accept; we answer with the client's when known. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  context: ToolContext;
  tools: ToolDefinition[];
  /** Diagnostics sink (stderr in production). Never the MCP channel. */
  logError?: (message: string) => void;
}

/** Serve MCP over the given streams until the input ends. */
export function serveMcp(options: McpServerOptions): Promise<void> {
  const log = options.logError ?? (() => {});
  const send = (response: JsonRpcResponse): void => {
    options.output.write(`${JSON.stringify(response)}\n`);
  };

  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        send(error(null, PARSE_ERROR, "parse error: message is not valid JSON"));
        return;
      }

      try {
        const response = handleMessage(message, options);
        if (response !== null) {
          send(response);
        }
      } catch (err) {
        // Defense in depth — handlers are expected to capture their own
        // failures; anything that escapes is logged and answered, never thrown.
        log(`agentctx mcp: ${err instanceof Error ? err.message : String(err)}`);
        send(error(idOf(message), INVALID_REQUEST, "internal error"));
      }
    });
    rl.on("close", () => resolvePromise());
  });
}

/** Returns the response to write, or null for notifications. */
function handleMessage(message: unknown, options: McpServerOptions): JsonRpcResponse | null {
  if (!isJsonObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return error(idOf(message), INVALID_REQUEST, "expected a JSON-RPC 2.0 request");
  }

  const id = idOf(message);
  const isNotification = !("id" in message);
  const params = isJsonObject(message.params) ? message.params : {};

  switch (message.method) {
    case "initialize":
      return result(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: "agentctx", version: VERSION },
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case "tools/call": {
      if (typeof params.name !== "string") {
        return error(id, INVALID_PARAMS, "tools/call requires a string 'name'");
      }
      const args = isJsonObject(params.arguments) ? params.arguments : {};
      const { payload, isError } = callTool(options.tools, options.context, params.name, args);
      return result(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError,
      });
    }
    default:
      // Notifications we don't act on (initialized, cancelled, …) are
      // acknowledged by silence; unknown *requests* get a proper error.
      if (isNotification) {
        return null;
      }
      return error(id, METHOD_NOT_FOUND, `method not found: ${message.method}`);
  }
}

function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

function result(id: JsonRpcId, payload: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: payload };
}

function error(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function idOf(message: unknown): JsonRpcId {
  if (isJsonObject(message) && (typeof message.id === "string" || typeof message.id === "number")) {
    return message.id;
  }
  return null;
}
