/**
 * Tests the canonical form of a git remote.
 *
 * The canonical form is what a duplicate resource is detected by and what a
 * machine's credential request is matched against, so every way a person
 * writes the same repository has to give the same string. Text that does not
 * identify a repository has to be rejected rather than reach a machine as a
 * git argument.
 */
import { describe, expect, it } from "vitest";

import { canonicalizeRemote } from "./remote";

describe("the canonical form of a remote", () => {
  it("is host/owner/repo, however the repository was written", () => {
    const canonical = "github.com/acme/web";
    for (const remote of [
      "https://github.com/acme/web",
      "https://github.com/acme/web.git",
      "https://github.com/acme/web.GIT",
      "https://GitHub.com/Acme/Web",
      "https://github.com/acme/web/",
      "  https://github.com/acme/web  ",
      "git@github.com:acme/web.git",
      "git@GitHub.com:Acme/Web",
      "https://github.com:443/acme/web",
      "ssh://git@github.com/acme/web.git",
      "github.com/acme/web",
    ]) {
      expect(canonicalizeRemote(remote), remote).toBe(canonical);
    }
  });

  it("keeps a self-hosted path, whether it is deeper or shallower than an owner and a repo", () => {
    expect(canonicalizeRemote("https://git.example.com/team/group/app.git")).toBe(
      "git.example.com/team/group/app",
    );
    // A host that serves a repository at the root of a path is still a
    // repository: only a remote with no path at all is rejected.
    expect(canonicalizeRemote("https://git.example.com/app.git")).toBe("git.example.com/app");
  });

  it("drops the credentials a URL carried rather than keeping them in the identity", () => {
    expect(canonicalizeRemote("https://octocat:ghp_token@github.com/acme/web")).toBe(
      "github.com/acme/web",
    );
  });

  it("reads the first colon of a scp-like remote as the host boundary", () => {
    // `git@host:1234/owner/repo` is a path beginning with 1234 on that host,
    // not a port: git's scp-like form has no port.
    expect(canonicalizeRemote("git@github.com:acme/web")).toBe("github.com/acme/web");
    expect(canonicalizeRemote("git@github.com:2222/acme/web")).toBe("github.com/2222/acme/web");
  });

  it("returns undefined for text that is not a repository", () => {
    for (const remote of [
      "",
      "   ",
      "github.com",
      "https://github.com",
      "https://github.com/",
      "https://github.com/acme/../../etc/passwd",
      "https://github.com/./web",
      "--upload-pack=touch /tmp/pwned",
      "-oProxyCommand=id",
    ]) {
      expect(canonicalizeRemote(remote), remote).toBeUndefined();
    }
  });

  it("converts a file URL to its path; the controller decides whether a user may use it", () => {
    expect(canonicalizeRemote("file:///Users/rogier/code/web")).toBe("users/rogier/code/web");
  });
});
