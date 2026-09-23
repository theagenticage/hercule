/**
 * What a user may write as a remote, and what a repository is called.
 *
 * The canonical form itself is tested in `@hercule/protocol`, where it lives
 * because the runner reads remotes by the same rule. What is asked here is the
 * controller's own narrower question - whether Hercule will hand this spelling to
 * git - which has to be refused where the user can read why rather than on a
 * machine as a git argument.
 */
import { describe, expect, it } from "vitest";

import { canonicalRemoteOf, isClonableRemote, extractRepoName } from "./remote";

describe("the remotes Hercule will hand to git", () => {
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

  it("reads a file URL as the path it is, which no resource may be written with", () => {
    expect(canonicalRemoteOf("file:///Users/rogier/code/web")).toBe("users/rogier/code/web");
    expect(isClonableRemote("file:///Users/rogier/code/web")).toBe(false);
  });
});

describe("what a repository is called", () => {
  it("is the last segment of its canonical remote", () => {
    expect(extractRepoName("github.com/acme/web")).toBe("web");
    expect(extractRepoName("git.example.com/team/group/app")).toBe("app");
  });
});
