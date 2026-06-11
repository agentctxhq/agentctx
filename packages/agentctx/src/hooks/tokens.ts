/**
 * Token estimation for injection budgets (SPEC §9).
 *
 * Budgets are enforced against an estimate, not a real tokenizer — pulling
 * in a tokenizer would violate the zero-dependency rule (SPEC §2.2) for a
 * limit that only needs to be conservative. ~4 characters per token is the
 * standard heuristic for English/code; `Math.ceil` keeps it pessimistic.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Hard-truncate `text` to fit a token budget, cutting at the last line or
 * word boundary in range when one exists. Returns "" for budgets too small
 * to carry the ellipsis marker.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }
  const marker = "\n…";
  if (maxChars <= marker.length) {
    return "";
  }
  let cut = text.slice(0, maxChars - marker.length);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  // Only back up to the boundary when it doesn't sacrifice most of the budget.
  if (lastBreak > cut.length / 2) {
    cut = cut.slice(0, lastBreak);
  }
  return cut + marker;
}
