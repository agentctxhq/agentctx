import { describe, expect, it } from "vitest";
import {
  normalizeGitRemoteUrl,
  projectIdFromPath,
  projectIdFromRemote,
} from "../../src/storage/namespace.js";

describe("normalizeGitRemoteUrl", () => {
  it("unifies scp-like, ssh, and https forms of the same remote", () => {
    const forms = [
      "git@github.com:Org/Repo.git",
      "ssh://git@github.com/Org/Repo.git",
      "https://github.com/org/repo",
      "https://github.com/Org/Repo.git",
      "https://user:secret@github.com/Org/Repo/",
      "  https://GitHub.com/Org/Repo.git  ",
    ];
    const normalized = forms.map(normalizeGitRemoteUrl);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("github.com/org/repo");
  });

  it("keeps different repos distinct", () => {
    expect(normalizeGitRemoteUrl("git@github.com:org/repo-a.git")).not.toBe(
      normalizeGitRemoteUrl("git@github.com:org/repo-b.git"),
    );
  });
});

describe("project ids", () => {
  it("hashes equivalent remotes to the same 64-hex id", () => {
    const a = projectIdFromRemote("git@github.com:Org/Repo.git");
    const b = projectIdFromRemote("https://github.com/org/repo");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forks with different remotes get different namespaces", () => {
    expect(projectIdFromRemote("git@github.com:upstream/repo.git")).not.toBe(
      projectIdFromRemote("git@github.com:fork-owner/repo.git"),
    );
  });

  it("falls back to a path hash distinct from remote hashes", () => {
    const fromPath = projectIdFromPath("/home/dev/projects/repo");
    expect(fromPath).toMatch(/^[0-9a-f]{64}$/);
    expect(fromPath).not.toBe(projectIdFromRemote("github.com/org/repo"));
  });
});
