/**
 * What a branch name may be when a caller writes one, and what a checkout
 * carries when a machine reports one back.
 *
 * A branch a caller writes ends up as an argument to a command on a machine -
 * `git checkout`, `git worktree add` - so it is held to git's own rules here, in
 * one refusal a caller can act on, rather than as a command that fails halfway
 * through on a runner. What comes back is a different thing: a fact, which the
 * record carries as the machine said it (D-21 F2).
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Branch, Checkout } from "./workspace";

const isAccepted = (schema: Schema.Codec<string>, value: string): boolean =>
  Schema.decodeUnknownExit(schema)(value)._tag === "Success";

describe("a branch name", () => {
  it("takes the names people write", () => {
    for (const branch of [
      "main",
      "feature/x",
      "hercule/run-3f1a2b7c",
      "release-2.1",
      "user/fix.bug",
      "a",
    ]) {
      expect(isAccepted(Branch, branch), branch).toBe(true);
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
      // D-21 F13: a component beginning with a dot is not a ref component.
      ".hidden",
      "feature/.git",
      `${"a".repeat(256)}`,
    ]) {
      expect(isAccepted(Branch, branch), JSON.stringify(branch)).toBe(false);
    }
  });
});

describe("a checkout as the API hands it out", () => {
  /**
   * D-21 F2: the machine could read no branch - a detached HEAD, or a clone of
   * an empty repository - and the record says so. Encoding it as `Branch` would
   * make the API unable to describe a checkout it is holding.
   */
  it("encodes a checkout the machine could read no branch for", () => {
    const checkout = {
      checkoutId: "0199e0e7-1111-7000-8000-000000000001",
      resourceId: "0199e0e7-1111-7000-8000-000000000002",
      form: "clone",
      subdirectory: null,
      branch: null,
      branches: [],
      defaultBranch: null,
    } as const;
    expect(Schema.encodeSync(Checkout)(checkout)).toMatchObject({ branch: null, branches: [] });
  });

  /**
   * And what a machine did say, whatever it is: a detached worktree reports
   * `(HEAD detached at abc1234)`-shaped words on some gits, and a record that
   * refused them would be a record of nothing.
   */
  it("encodes a branch a caller could never have asked for", () => {
    expect(
      Schema.encodeSync(Checkout)({
        checkoutId: "0199e0e7-1111-7000-8000-000000000001",
        resourceId: "0199e0e7-1111-7000-8000-000000000002",
        form: "worktree",
        subdirectory: null,
        branch: ".hidden",
        branches: [".hidden"],
        defaultBranch: null,
      }),
    ).toMatchObject({ branch: ".hidden" });
  });
});
