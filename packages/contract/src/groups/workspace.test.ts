/**
 * What a branch name and a folder may be.
 *
 * Both end up as arguments to a command on a machine - `git checkout`, `git
 * worktree add`, a clone into a directory - so what a caller writes is held to
 * git's own rules here, in one refusal a caller can act on, rather than as a
 * command that fails halfway through on a runner.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AdoptPath, Branch } from "./workspace";

const takes = (schema: Schema.Codec<string>, value: string): boolean =>
  Schema.decodeUnknownExit(schema)(value)._tag === "Success";

describe("a branch name", () => {
  it("takes the names people write", () => {
    for (const branch of [
      "main",
      "feature/x",
      "hydra/run-3f1a2b7c",
      "release-2.1",
      "user/fix.bug",
      "a",
    ]) {
      expect(takes(Branch, branch), branch).toBe(true);
    }
  });

  it("refuses what git refuses, and what a shell would read as an option", () => {
    for (const branch of [
      "",
      "-f",
      "--upload-pack=id",
      "feature/../etc",
      "feature..x",
      "feature/",
      "feature.lock",
      "head@{1}",
      "feature x",
      "feature\tx",
      "feature\nx",
      "feature~1",
      "feature^",
      "feature:x",
      "feature?",
      "feature*",
      "feature[1]",
      "feature\\x",
      `${"a".repeat(256)}`,
    ]) {
      expect(takes(Branch, branch), JSON.stringify(branch)).toBe(false);
    }
  });
});

describe("a folder to adopt", () => {
  it("takes an absolute path", () => {
    for (const path of ["/Users/rogier/code/web", "/srv/repos/web", "/a"]) {
      expect(takes(AdoptPath, path), path).toBe(true);
    }
  });

  it("refuses a relative one, and one git would read as an option", () => {
    for (const path of ["", "code/web", "./code/web", "~/code/web", "-o/tmp/x", "--git-dir=/tmp"]) {
      expect(takes(AdoptPath, path), JSON.stringify(path)).toBe(false);
    }
  });
});
