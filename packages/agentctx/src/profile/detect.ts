/**
 * Project profile auto-detection (SPEC §3.2 `profile`, issue 2/7).
 *
 * Rule-based, deterministic, LLM-free: read well-known manifests and emit
 * keyed `profile` entries — "Stack", "Commands", "Entry points". Titles are
 * stable keys; the record store's keyed supersession (SPEC §3.5) refreshes
 * them on re-detection. Anything unreadable is skipped silently — detection
 * must never fail init.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { insertRecord, listRecords } from "../storage/records.js";
import { BODY_MAX_CHARS } from "../storage/types.js";

export interface ProfileEntry {
  title: string;
  body: string;
}

export const PROFILE_TITLES = {
  stack: "Stack",
  commands: "Commands",
  entryPoints: "Entry points",
} as const;

/** Dependencies worth naming in the stack summary, by display label. */
const NOTABLE_DEPENDENCIES: Record<string, string> = {
  react: "React",
  next: "Next.js",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@angular/core": "Angular",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  "@nestjs/core": "NestJS",
  electron: "Electron",
  vite: "Vite",
  "better-sqlite3": "better-sqlite3 (SQLite)",
  prisma: "Prisma",
  "drizzle-orm": "Drizzle ORM",
  mongoose: "Mongoose (MongoDB)",
  pg: "node-postgres",
  vitest: "Vitest",
  jest: "Jest",
  mocha: "Mocha",
  playwright: "Playwright",
  cypress: "Cypress",
  "@biomejs/biome": "Biome",
  eslint: "ESLint",
  prettier: "Prettier",
};

/** Script names surfaced first in the Commands entry, in this order. */
const PRIMARY_SCRIPTS = [
  "dev",
  "start",
  "build",
  "test",
  "lint",
  "format",
  "typecheck",
  "check",
] as const;

const MAX_SCRIPTS = 12;

interface PackageJson {
  name?: unknown;
  bin?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  scripts?: unknown;
  engines?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

/**
 * Detect the project profile for `dir`. Returns only entries with content;
 * an unrecognizable directory yields `[]`.
 */
export function detectProjectProfile(dir: string): ProfileEntry[] {
  const pkg = readPackageJson(dir);
  const entries: ProfileEntry[] = [];

  const stack = detectStack(dir, pkg);
  if (stack.length > 0) {
    entries.push({ title: PROFILE_TITLES.stack, body: clip(stack.join("\n")) });
  }

  if (pkg !== null) {
    const commands = detectCommands(dir, pkg);
    if (commands.length > 0) {
      entries.push({ title: PROFILE_TITLES.commands, body: clip(commands.join("\n")) });
    }
    const entryPoints = detectEntryPoints(pkg);
    if (entryPoints.length > 0) {
      entries.push({ title: PROFILE_TITLES.entryPoints, body: clip(entryPoints.join("\n")) });
    }
  }

  return entries;
}

export interface ProfileRefreshResult {
  created: string[];
  refreshed: string[];
  unchanged: string[];
}

/**
 * Write detected entries as `profile` records for `projectId`. Keyed
 * supersession replaces a stale entry with the same title; entries whose
 * body is unchanged are skipped so re-running init causes no churn.
 */
export function refreshProjectProfile(
  db: Database,
  projectId: string,
  entries: ProfileEntry[],
): ProfileRefreshResult {
  const current = new Map(
    listRecords(db, projectId, { type: "profile" }).map((record) => [record.title, record.body]),
  );

  const result: ProfileRefreshResult = { created: [], refreshed: [], unchanged: [] };
  for (const entry of entries) {
    const existingBody = current.get(entry.title);
    if (existingBody === entry.body) {
      result.unchanged.push(entry.title);
      continue;
    }
    insertRecord(db, {
      projectId,
      type: "profile",
      title: entry.title,
      body: entry.body,
      source: "cli",
      confidence: "explicit",
    });
    (existingBody === undefined ? result.created : result.refreshed).push(entry.title);
  }
  return result;
}

function detectStack(dir: string, pkg: PackageJson | null): string[] {
  const lines: string[] = [];

  if (pkg !== null) {
    const engines = isObject(pkg.engines) ? pkg.engines : {};
    const nodeRange = typeof engines.node === "string" ? ` (node ${engines.node})` : "";
    lines.push(`Runtime: Node.js${nodeRange}`);

    const deps = collectDependencies(pkg);
    if (deps.has("typescript") || existsSync(join(dir, "tsconfig.json"))) {
      lines.push("Language: TypeScript");
    }

    const notable = [...deps]
      .filter((name) => name in NOTABLE_DEPENDENCIES)
      .map((name) => NOTABLE_DEPENDENCIES[name]);
    if (notable.length > 0) {
      lines.push(`Key dependencies: ${notable.join(", ")}`);
    }

    const pm = detectPackageManager(dir, pkg);
    if (pm !== null) {
      lines.push(`Package manager: ${pm}`);
    }
    const workspaces = workspacePackages(pkg.workspaces);
    if (workspaces.length > 0) {
      lines.push(`Monorepo: workspaces (${workspaces.join(", ")})`);
    }
  }

  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "requirements.txt"))) {
    lines.push("Language: Python");
  }
  if (existsSync(join(dir, "Cargo.toml"))) {
    lines.push("Language: Rust");
  }
  if (existsSync(join(dir, "go.mod"))) {
    lines.push("Language: Go");
  }

  return lines;
}

function detectCommands(dir: string, pkg: PackageJson): string[] {
  const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
  const names = Object.keys(scripts).filter((name) => typeof scripts[name] === "string");
  if (names.length === 0) {
    return [];
  }

  const ordered = [
    ...PRIMARY_SCRIPTS.filter((name) => names.includes(name)),
    ...names.filter((name) => !(PRIMARY_SCRIPTS as readonly string[]).includes(name)).sort(),
  ].slice(0, MAX_SCRIPTS);

  const runner = scriptRunner(detectPackageManager(dir, pkg));
  return ordered.map((name) => `${runner} ${name} — ${String(scripts[name])}`);
}

function detectEntryPoints(pkg: PackageJson): string[] {
  const lines: string[] = [];

  if (typeof pkg.bin === "string") {
    lines.push(`bin: ${pkg.bin}`);
  } else if (isObject(pkg.bin)) {
    for (const [name, target] of Object.entries(pkg.bin)) {
      lines.push(`bin ${name}: ${String(target)}`);
    }
  }
  if (typeof pkg.main === "string") {
    lines.push(`main: ${pkg.main}`);
  }
  if (typeof pkg.module === "string") {
    lines.push(`module: ${pkg.module}`);
  }
  if (pkg.exports !== undefined) {
    const keys = isObject(pkg.exports) ? Object.keys(pkg.exports).join(", ") : String(pkg.exports);
    lines.push(`exports: ${keys}`);
  }

  return lines;
}

function detectPackageManager(dir: string, pkg: PackageJson): string | null {
  if (typeof pkg.packageManager === "string") {
    // e.g. "pnpm@9.1.0" → "pnpm"
    const name = pkg.packageManager.split("@")[0];
    if (name !== undefined && name.length > 0) {
      return name;
    }
  }
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return null;
}

function scriptRunner(packageManager: string | null): string {
  switch (packageManager) {
    case "pnpm":
      return "pnpm run";
    case "yarn":
      return "yarn";
    case "bun":
      return "bun run";
    default:
      return "npm run";
  }
}

function collectDependencies(pkg: PackageJson): Set<string> {
  const deps = new Set<string>();
  for (const group of [pkg.dependencies, pkg.devDependencies]) {
    if (isObject(group)) {
      for (const name of Object.keys(group)) {
        deps.add(name);
      }
    }
  }
  return deps;
}

function workspacePackages(workspaces: unknown): string[] {
  if (Array.isArray(workspaces)) {
    return workspaces.filter((workspace): workspace is string => typeof workspace === "string");
  }
  if (isObject(workspaces) && Array.isArray(workspaces.packages)) {
    return workspaces.packages.filter(
      (workspace): workspace is string => typeof workspace === "string",
    );
  }
  return [];
}

function readPackageJson(dir: string): PackageJson | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return isObject(parsed) ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(body: string): string {
  return body.length <= BODY_MAX_CHARS ? body : `${body.slice(0, BODY_MAX_CHARS - 1)}…`;
}
