/**
 * E2E checks against the built bin (`dist/cli.js`) — exercised when the
 * package has been built (CI runs build before test via `npm run check`
 * locally; skipped otherwise). The hook contract matters most: it must
 * exit 0 silently no matter what, so a half-installed agentctx can never
 * break a Claude Code session.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { digestFilePath } from "../../src/hooks/digest.js";
import { projectIdFromPath } from "../../src/storage/namespace.js";

const binPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

// Hooks resolve their data dir from AGENTCTX_HOME — point it at a sandbox so
// e2e runs never touch (or create) a real ~/.agentctx.
const sandbox = mkdtempSync(join(tmpdir(), "agentctx-e2e-"));

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function run(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], {
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, AGENTCTX_HOME: join(sandbox, "agentctx-home") },
      ...(input === undefined ? {} : { input }),
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

  it("hook session-start emits the digest as hook JSON over the real stdin contract", () => {
    const home = join(sandbox, "agentctx-home");
    const cwd = join(sandbox, "project");
    mkdirSync(cwd, { recursive: true });
    const digestPath = digestFilePath(home, projectIdFromPath(cwd));
    mkdirSync(dirname(digestPath), { recursive: true });
    writeFileSync(
      digestPath,
      JSON.stringify({ version: 1, sections: { profile: "E2E-DIGEST-MARKER" } }),
      "utf8",
    );

    const result = run(
      ["hook", "session-start"],
      JSON.stringify({
        session_id: "e2e",
        cwd,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("E2E-DIGEST-MARKER");
  });

  it("hook swallows garbage stdin", () => {
    const result = run(["hook", "user-prompt-submit"], "][ not json");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("prints version and help", () => {
    expect(run(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(run(["--help"]).stdout).toContain("Usage: agentctx");
  });

  it("fails on unknown commands", () => {
    expect(run(["frobnicate"]).status).toBe(1);
  });
});
