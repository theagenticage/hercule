/**
 * What a remote is, and what two spellings of one repository share.
 *
 * The canonical form is what a second resource collides on and what a machine's
 * credential request is matched against, so every way a person writes the same
 * repository has to land on the same string - and everything that is not a
 * remote has to be refused here, where the user can read why, rather than on a
 * machine as a git argument.
 */
import { describe, expect, it } from "vitest";
import { canonicalRemoteOf, isClonableRemote, repoNameOf } from "./remote";

describe("the canonical form of a remote", () => {
  it("is host/owner/repo, however the repository was spelled", () => {
    const canonical = "github.com/acme/web";
    for (const remote of [
      "https://github.com/acme/web",
      "https://github.com/acme/web.git",
      "https://GitHub.com/Acme/Web",
      "https://github.com/acme/web/",
      "  https://github.com/acme/web  ",
      "git@github.com:acme/web.git",
      "git@GitHub.com:Acme/Web",
      "https://github.com:443/acme/web",
      "ssh://git@github.com/acme/web.git",
      "github.com/acme/web",
    ]) {
      expect(canonicalRemoteOf(remote), remote).toBe(canonical);
    }
  });

  it("keeps a self-hosted path, whether it is deeper or shallower than an owner and a repo", () => {
    expect(canonicalRemoteOf("https://git.example.com/team/group/app.git")).toBe(
      "git.example.com/team/group/app",
    );
    // A host that serves a repository at the root of a path is still a
    // repository: what is refused is a remote with no path at all.
    expect(canonicalRemoteOf("https://git.example.com/app.git")).toBe("git.example.com/app");
  });

  it("drops the credentials a URL carried rather than keeping them in the identity", () => {
    expect(canonicalRemoteOf("https://octocat:ghp_token@github.com/acme/web")).toBe(
      "github.com/acme/web",
    );
  });

  it("reads the first colon of a scp-like remote as the host boundary", () => {
    // `git@host:1234/owner/repo` is a path beginning with 1234 on that host,
    // not a port: git's own spelling has no port in it.
    expect(canonicalRemoteOf("git@github.com:acme/web")).toBe("github.com/acme/web");
    expect(canonicalRemoteOf("git@github.com:2222/acme/web")).toBe("github.com/2222/acme/web");
  });

  it("names nothing for a word that is not a repository", () => {
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
      expect(canonicalRemoteOf(remote), remote).toBeUndefined();
    }
  });

  it("reads a file URL as the path it is, which no resource may be written with", () => {
    expect(canonicalRemoteOf("file:///Users/rogier/code/web")).toBe("users/rogier/code/web");
    expect(isClonableRemote("file:///Users/rogier/code/web")).toBe(false);
  });
});

/**
 * What a user may write on a resource is narrower than what canonicalises: a
 * machine names the remote it is talking to as `host/owner/repo`, and that has
 * to keep matching the resource it belongs to.
 */
describe("the remotes Hydra will hand to git", () => {
  it("takes an https URL and git's own user@host:owner/repo", () => {
    for (const remote of [
      "https://github.com/acme/web",
      "https://github.com/acme/web.git",
      "git@github.com:acme/web.git",
      " https://github.com/acme/web ",
    ]) {
      expect(isClonableRemote(remote), remote).toBe(true);
    }
  });

  it("refuses a local or shell-reachable spelling, and one git would read as an option", () => {
    for (const remote of [
      "file:///Users/rogier/code/web",
      "ssh://git@github.com/acme/web.git",
      "git://github.com/acme/web.git",
      "http://github.com/acme/web",
      "/Users/rogier/code/web",
      "-oProxyCommand=id",
      "--upload-pack=id",
      "",
    ]) {
      expect(isClonableRemote(remote), remote).toBe(false);
    }
  });

  it("still canonicalises what a machine reports, which is not a spelling anyone clones", () => {
    expect(isClonableRemote("github.com/acme/web")).toBe(false);
    expect(canonicalRemoteOf("github.com/acme/web")).toBe("github.com/acme/web");
  });
});

describe("what a repository is called", () => {
  it("is the last segment of its canonical remote", () => {
    expect(repoNameOf("github.com/acme/web")).toBe("web");
    expect(repoNameOf("git.example.com/team/group/app")).toBe("app");
  });
});
