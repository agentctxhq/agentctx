/**
 * E2E checks against the built bin (`dist/cli.js`) — exercised when the
 * package has been built (CI runs build before test via `npm run check`
 * locally; skipped otherwise). The hook contract matters most: it must
 * exit 0 silently no matter what, so a half-installed agentctx can never
 * break a Claude Code session.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const binPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe.skipIf(!existsSync(binPath))("dist/cli.js", () => {
  it("hook exits 0 silently for every event — known, unknown, or missing", () => {
    for (const args of [
      ["hook", "session-start"],
      ["hook", "user-prompt-submit"],
      ["hook", "stop"],
      ["hook", "definitely-not-an-event"],
      ["hook"],
    ]) {
      const result = run(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });

  it("prints version and help", () => {
    expect(run(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(run(["--help"]).stdout).toContain("Usage: agentctx");
  });

  it("fails on unknown commands", () => {
    expect(run(["frobnicate"]).status).toBe(1);
  });
});
