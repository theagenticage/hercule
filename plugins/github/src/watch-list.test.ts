/** Tests the watch list: the union of linked repo Resources and the config's repositories. */
import { describe, expect, it } from "vitest";
import type { LinkedResource } from "@hercule/plugin-host";
import { buildWatchList } from "./watch-list";

/** Builds a linked Resource of `kind` with `remote`. */
const buildResource = (
  remote: string | null,
  kind: LinkedResource["kind"] = "repo",
): LinkedResource => ({ id: `res_${String(remote)}`, kind, label: null, remote });

describe("buildWatchList", () => {
  it("joins the repo Resources on github.com with the config's repositories", () => {
    const watchList = buildWatchList(
      [buildResource("github.com/octocat/hello-world")],
      ["octocat/spoon-knife"],
    );

    expect(watchList).toEqual(["octocat/hello-world", "octocat/spoon-knife"]);
  });

  it("lists a repository named in both places, in any case, once and in lowercase", () => {
    const watchList = buildWatchList(
      [buildResource("github.com/Octocat/Hello-World")],
      ["octocat/hello-world", "OCTOCAT/HELLO-WORLD"],
    );

    expect(watchList).toEqual(["octocat/hello-world"]);
  });

  it("ignores Resources on other hosts, of other kinds, or without a remote", () => {
    const watchList = buildWatchList(
      [
        buildResource("gitlab.com/octocat/hello-world"),
        buildResource("github.example.com/octocat/hello-world"),
        buildResource("github.com/octocat/hello-world", "folder"),
        buildResource(null),
      ],
      [],
    );

    expect(watchList).toEqual([]);
  });

  it("ignores a github.com remote whose repository is not a valid owner/repo", () => {
    const watchList = buildWatchList(
      [
        buildResource("github.com/octocat/%2e%2e"),
        buildResource("github.com/octocat/.."),
        buildResource("github.com/octocat/hello?x=1"),
        buildResource("github.com/octocat/hello#readme"),
        buildResource("github.com/octocat/hello-world"),
      ],
      [],
    );

    expect(watchList).toEqual(["octocat/hello-world"]);
  });
});
