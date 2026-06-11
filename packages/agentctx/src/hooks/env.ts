/**
 * Hook environment: everything a hook handler touches — paths, stdin, stdout,
 * subprocess spawning, logging — in one injectable object, so tests run
 * handlers against temp directories and capture their effects.
 *
 * Failure policy (SPEC §8 rung 5): hooks never error into the session. The
 * default `log` appends to `~/.agentctx/logs/hooks.log` and swallows its own
 * failures; nothing in this module throws past the runner's catch-all.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** How long a hook waits for Claude Code's stdin payload before giving up. */
const STDIN_TIMEOUT_MS = 5000;

export interface HookEnv {
  /** Fallback working directory when the payload carries no `cwd`. */
  cwd: string;
  /** Data directory, default `~/.agentctx` (SPEC §2.4). */
  agentctxHome: string;
  dbPath: string;
  /** Where per-session dedup files live (SPEC §4): the system temp dir. */
  tmpDir: string;
  /** Read the raw hook payload from stdin (bounded; resolves "" on timeout). */
  readStdin(): Promise<string>;
  /** Emit a hook JSON response on stdout. */
  emit(output: unknown): void;
  /** Spawn `agentctx <args…>` detached — fire-and-forget (SPEC §4 Stop/SessionEnd). */
  spawnDetached(args: string[]): void;
  /** Record a swallowed failure. Must never throw. */
  log(message: string): void;
  now(): Date;
}

export function defaultHookEnv(cwd: string = process.cwd()): HookEnv {
  const agentctxHome = process.env.AGENTCTX_HOME ?? join(homedir(), ".agentctx");
  return {
    cwd,
    agentctxHome,
    dbPath: join(agentctxHome, "agentctx.db"),
    tmpDir: tmpdir(),
    readStdin: () => readStream(process.stdin, STDIN_TIMEOUT_MS),
    emit: (output) => process.stdout.write(`${JSON.stringify(output)}\n`),
    spawnDetached: spawnAgentctxDetached,
    log: (message) => logToFile(agentctxHome, message),
    now: () => new Date(),
  };
}

/**
 * Collect a stream until end-of-input or timeout, then release it so an
 * unterminated stdin can never keep the hook process alive.
 */
export function readStream(stream: NodeJS.ReadStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (stream.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        stream.pause();
        stream.destroy();
      } catch {
        /* releasing stdin must never fail the hook */
      }
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

/**
 * Re-invoke this same CLI install detached. Uses the running entry script
 * when known (immune to PATH differences in the detached child), falling
 * back to the PATH-resolved `agentctx`.
 */
function spawnAgentctxDetached(args: string[]): void {
  const entry = process.argv[1];
  const [command, prefix] =
    entry === undefined ? ["agentctx", [] as string[]] : [process.execPath, [entry]];
  const child = spawn(command, [...prefix, ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function logToFile(agentctxHome: string, message: string): void {
  try {
    const dir = join(agentctxHome, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "hooks.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    /* logging must never become a hook failure */
  }
}
