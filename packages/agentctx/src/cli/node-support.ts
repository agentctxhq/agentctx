/**
 * Node support matrix (OQ-1, ADR-003).
 *
 * `better-sqlite3` is a native module shipped as prebuilt binaries per Node
 * ABI version; no compiler is allowed on the install path (Invariant 4).
 * Supported: Node 20, 22, and 24 (the LTS lines with published prebuilds in
 * the pinned better-sqlite3 major). Newer majors work as soon as upstream
 * publishes prebuilds — until then the native load fails and we say why
 * clearly instead of letting users fall into a node-gyp compile.
 *
 * Dependency-free on purpose: this module must be loadable on any Node
 * version, including ones where better-sqlite3 cannot load.
 */

export const MIN_NODE_MAJOR = 20;

/** LTS lines with better-sqlite3 prebuilds — the tested support matrix. */
export const SUPPORTED_NODE_LTS = [20, 22, 24] as const;

export const NODE_SUPPORT_MATRIX = `agentctx supports Node ${SUPPORTED_NODE_LTS.join(", ")} (LTS lines with better-sqlite3 prebuilt binaries).
Other Node majors work only once better-sqlite3 publishes prebuilds for them —
agentctx never compiles native code at install time.`;

/**
 * Reason this Node version is unsupported, or null when it is fine.
 * Only the hard floor is rejected up front; missing prebuilds on newer
 * majors are detected at native-module load time (`describeNativeLoadError`).
 */
export function unsupportedNodeReason(version: string = process.versions.node): string | null {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isNaN(major)) {
    return null; // unparseable — let the runtime decide rather than guess
  }
  if (major < MIN_NODE_MAJOR) {
    return `Node ${version} is not supported — agentctx requires Node ≥ ${MIN_NODE_MAJOR}.\n${NODE_SUPPORT_MATRIX}`;
  }
  return null;
}

/**
 * Map a failed better-sqlite3 native load to a clear, actionable message,
 * or null when the error is something else. Covers the two real-world
 * shapes: ABI mismatch (Node switched after install, e.g. via nvm) and a
 * missing binding (no prebuild existed and install skipped the compile).
 */
export function describeNativeLoadError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const abiMismatch = message.includes("NODE_MODULE_VERSION");
  const missingBinding =
    message.includes("Could not locate the bindings file") ||
    message.includes("better_sqlite3.node") ||
    (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_DLOPEN_FAILED");
  if (!abiMismatch && !missingBinding) {
    return null;
  }
  const cause = abiMismatch
    ? `better-sqlite3 was installed under a different Node version than the one running now (${process.versions.node})`
    : `better-sqlite3 has no native binary for this Node version (${process.versions.node})`;
  return `${cause}.\n${NODE_SUPPORT_MATRIX}\nFix: switch to a supported Node LTS, then reinstall: npm install -g @agentctxhq/agentctx`;
}
