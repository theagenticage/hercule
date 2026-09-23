/**
 * Which remotes a user may enter, and how a repository's name is derived.
 *
 * The canonical form itself is tested in `@hercule/protocol`, where it lives
 * because the runner canonicalizes remotes by the same rule. These tests cover
 * the controller's narrower check - whether Hercule will pass a remote to git -
 * which must reject a bad remote where the user can read why, rather than on a
 * runner as a git argument.
 */
import { describe, expect, it } from "vitest";

import { canonicalRemoteOf, isClonableRemote, extractRepoName } from "./remote";

describe("isClonableRemote", () => {
  it("accepts an https URL and git's scp-like user@host:owner/repo", () => {
    for (const remote of [
      "https://github.com/acme/web",
      "https://github.com/acme/web.git",
      "git@github.com:acme/web.git",
      " https://github.com/acme/web ",
    ]) {
      expect(isClonableRemote(remote), remote).toBe(true);
    }
  });

  it("rejects local paths, other schemes, and a remote git would read as an option", () => {
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

  it("rejects the host/path form a runner reports, which still canonicalizes", () => {
    expect(isClonableRemote("github.com/acme/web")).toBe(false);
    expect(canonicalRemoteOf("github.com/acme/web")).toBe("github.com/acme/web");
  });

  it("canonicalizes a file URL to its path, but rejects it as a resource remote", () => {
    expect(canonicalRemoteOf("file:///Users/rogier/code/web")).toBe("users/rogier/code/web");
    expect(isClonableRemote("file:///Users/rogier/code/web")).toBe(false);
  });
});

describe("extractRepoName", () => {
  it("returns the last segment of the canonical remote", () => {
    expect(extractRepoName("github.com/acme/web")).toBe("web");
    expect(extractRepoName("git.example.com/team/group/app")).toBe("app");
  });
});
