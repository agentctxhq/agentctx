/**
 * Anthropic Messages API client for extraction (SPEC §6, ADR-009).
 *
 * Plain fetch, no SDK: the v0.1 target is zero runtime dependencies beyond
 * better-sqlite3 (SPEC §2.2), and ADR-009 explicitly allows raw fetch for
 * this one call. Haiku 4.5 with a prompt-caching breakpoint on the system
 * prompt — after the first session of the day, system-prompt reads cost 0.1×.
 */

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const EXTRACTION_MODEL = "claude-haiku-4-5";
export const EXTRACTION_MAX_TOKENS = 4096;

/** Haiku 4.5 pricing, USD per million tokens (ADR-009). */
export const PRICE_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  /** 5-minute-TTL cache write premium: 1.25× input. */
  cacheWrite: 1.25,
  /** Cache read: 0.1× input. */
  cacheRead: 0.1,
} as const;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ModelResponse {
  /** Concatenated text blocks of the response. */
  text: string;
  /** Cost of this call in USD, computed from the usage block. */
  costUsd: number;
}

export class ExtractionApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ExtractionApiError";
    this.status = status;
  }
}

/** One Messages API call with the cache breakpoint on the system prompt. */
export async function requestCompletion(
  fetchFn: FetchLike,
  apiKey: string,
  systemPrompt: string,
  userContent: string,
): Promise<ModelResponse> {
  const response = await fetchFn(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      max_tokens: EXTRACTION_MAX_TOKENS,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!response.ok) {
    const body = await safeText(response);
    throw new ExtractionApiError(
      `Anthropic API returned ${response.status}: ${body.slice(0, 500)}`,
      response.status,
    );
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  return { text: responseText(parsed), costUsd: usageCostUsd(parsed.usage) };
}

function responseText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/** Cost from the API usage block. Unknown/missing fields count as zero. */
export function usageCostUsd(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) {
    return 0;
  }
  const u = usage as Record<string, unknown>;
  const tokens = (key: string): number => (typeof u[key] === "number" ? (u[key] as number) : 0);
  return (
    (tokens("input_tokens") * PRICE_PER_MTOK.input +
      tokens("output_tokens") * PRICE_PER_MTOK.output +
      tokens("cache_creation_input_tokens") * PRICE_PER_MTOK.cacheWrite +
      tokens("cache_read_input_tokens") * PRICE_PER_MTOK.cacheRead) /
    1_000_000
  );
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
