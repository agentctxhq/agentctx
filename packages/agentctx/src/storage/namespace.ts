/**
 * Project namespacing (SPEC §3.4).
 *
 * `project_id` = SHA-256 of the normalized git remote URL (origin), so two
 * clones of one repo share a namespace while a fork with a different remote
 * does not. Fallback when no remote exists: SHA-256 of the absolute repo
 * root path (or cwd outside a repo).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export { GLOBAL_PROJECT_ID } from "./types.js";
export const PROJECT_ID_DISPLAY_LEN = 12;

/**
 * Normalize a git remote URL to a canonical `host/path` form: unifies
 * `git@host:path`, `ssh://git@host/path`, and `https://host/path`; strips
 * credentials, ports, the `.git` suffix, and trailing slashes; lowercases.
 */
export function normalizeGitRemoteUrl(url: string): string {
  const trimmed = url.trim();
  let host: string;
  let path: string;

  const protocolMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed);
  if (protocolMatch) {
    const parsed = new URL(trimmed);
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like syntax: [user@]host:path
    const scpMatch = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (scpMatch) {
      host = scpMatch[1] ?? "";
      path = scpMatch[2] ?? "";
    } else {
      // Not URL-shaped (e.g. a local path remote); use as-is.
      host = "";
      path = trimmed;
    }
  }

  path = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const canonical = host === "" ? path : `${host}/${path}`;
  return canonical.toLowerCase();
}

export function projectIdFromRemote(remoteUrl: string): string {
  return sha256(normalizeGitRemoteUrl(remoteUrl));
}

export function projectIdFromPath(repoRoot: string): string {
  return sha256(resolve(repoRoot));
}

/**
 * Resolve the project namespace for a working directory: origin remote hash
 * if available, else repo-root path hash, else cwd path hash.
 */
export function resolveProjectId(cwd: string = process.cwd()): string {
  const remote = git(["remote", "get-url", "origin"], cwd);
  if (remote !== null) {
    return projectIdFromRemote(remote);
  }
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  return projectIdFromPath(repoRoot ?? cwd);
}

export function shortProjectId(projectId: string): string {
  return `${projectId.slice(0, PROJECT_ID_DISPLAY_LEN)}…`;
}

function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
