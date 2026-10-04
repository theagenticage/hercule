/** Tests which spellings of a repository the plugin accepts. */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { RepoName } from "./repo-name";

const decodeRepoName = Schema.decodeUnknownResult(RepoName);

describe("RepoName", () => {
  it("accepts owner/repo with the characters GitHub allows", () => {
    for (const repo of [
      "octocat/hello-world",
      "a-b/c.d_e",
      "octocat/hello-world.js",
      "o/.github",
    ]) {
      expect(Result.isSuccess(decodeRepoName(repo)), repo).toBe(true);
    }
  });

  it("refuses anything that is not one owner and one repository name", () => {
    for (const repo of [
      "hello-world",
      "octocat/hello/world",
      "github.com/octocat/hello-world",
      "/x",
      "a b/c",
      "octo_cat/hello-world",
    ]) {
      expect(Result.isFailure(decodeRepoName(repo)), repo).toBe(true);
    }
  });

  it("refuses a repository name made of dots only, which a REST path would misread", () => {
    expect(Result.isFailure(decodeRepoName("octocat/.."))).toBe(true);
    expect(Result.isFailure(decodeRepoName("octocat/."))).toBe(true);
  });
});
