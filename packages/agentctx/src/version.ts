/**
 * Version constant in its own dependency-free module so `agentctx --version`
 * and `--help` never load better-sqlite3 (index.ts re-exports the storage
 * surface, which does).
 */
export const VERSION = "0.1.0";
