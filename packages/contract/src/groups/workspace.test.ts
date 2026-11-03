/**
 * Tests which branch names a caller may write, and what a checkout holds when a
 * machine reports it back.
 *
 * A branch a caller writes becomes an argument to a command on a machine -
 * `git checkout`, `git worktree add` - so it is validated against git's own
 * rules here, with one error a caller can act on, rather than by a command that
 * fails halfway through on a runner. What comes back is different: a fact the
 * machine reported, which the record holds exactly as reported.
 *
 * Also tests that `workspace.disposeMany` refuses a key it does not declare, so
 * a misspelled `expectedLastUsedAt` cannot turn a guarded removal into an
 * unguarded one.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Branch, Checkout, StartingRevision, WorkspaceDisposeManyInput } from "./workspace";

const isAccepted = (schema: Schema.Codec<string>, value: string): boolean =>
  Schema.decodeUnknownExit(schema)(value)._tag === "Success";

describe("a branch name", () => {
  it("accepts the names people write", () => {
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

  it("rejects what git rejects, and what git would read as an option", () => {
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
      // git does not accept a path component that begins with a dot.
      ".hidden",
      "feature/.git",
      `${"a".repeat(256)}`,
    ]) {
      expect(isAccepted(Branch, branch), JSON.stringify(branch)).toBe(false);
    }
  });
});

describe("a checkout as the API returns it", () => {
  /**
   * The machine could not read a branch - a detached HEAD, or a clone of an
   * empty repository - and the record holds null. Encoding the field as
   * `Branch` would make the API unable to describe a checkout it holds.
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
      baseBranch: null,
      remoteBranches: [],
      headCommit: null,
      baseCommit: null,
      startingRevision: null,
    } as const;
    expect(Schema.encodeSync(Checkout)(checkout)).toMatchObject({ branch: null, branches: [] });
  });

  /**
   * A branch the machine reported is kept whatever it is: on some git
   * versions a detached worktree reports text like `(HEAD detached at
   * abc1234)`, and a record that rejected it would be useless.
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
        baseBranch: null,
        remoteBranches: [],
        headCommit: null,
        baseCommit: null,
        startingRevision: null,
      }),
    ).toMatchObject({ branch: ".hidden" });
  });
});

describe("a starting revision", () => {
  it("preserves all four explicit choices without inventing a remote branch", () => {
    for (const revision of [
      { kind: "current" },
      { kind: "local", branch: "main" },
      { kind: "remote", branch: "main" },
      { kind: "remote" },
    ]) {
      expect(Schema.decodeUnknownSync(StartingRevision)(revision)).toEqual(revision);
    }
  });

  it("refuses missing local names, non-string branch values and unknown kinds", () => {
    for (const revision of [
      { kind: "local" },
      { kind: "local", branch: 12 },
      { kind: "remote", branch: 12 },
      { kind: "commit", commit: "123" },
      { kind: "anything" },
    ]) {
      expect(Schema.decodeUnknownExit(StartingRevision)(revision)._tag).toBe("Failure");
    }
  });
});

describe("the payload of workspace.disposeMany", () => {
  const WORKSPACE_ID = "0199e0e7-0000-7000-8000-000000000010";
  const decode = (input: unknown) =>
    Schema.decodeUnknownExit(WorkspaceDisposeManyInput)(input)._tag;

  it("accepts items with and without expectedLastUsedAt", () => {
    expect(
      decode({
        items: [
          { workspaceId: WORKSPACE_ID },
          { workspaceId: WORKSPACE_ID, expectedLastUsedAt: "2026-11-03T10:00:00.000Z" },
        ],
      }),
    ).toBe("Success");
  });

  it("refuses an unknown key in an item", () => {
    expect(
      decode({
        items: [{ workspaceId: WORKSPACE_ID, expectedLastUsed: "2026-11-03T10:00:00.000Z" }],
      }),
    ).toBe("Failure");
  });

  it("refuses an unknown key beside items", () => {
    expect(decode({ items: [{ workspaceId: WORKSPACE_ID }], force: true })).toBe("Failure");
  });

  it("refuses no items and more than 200 items", () => {
    expect(decode({ items: [] })).toBe("Failure");
    expect(
      decode({ items: Array.from({ length: 201 }, () => ({ workspaceId: WORKSPACE_ID })) }),
    ).toBe("Failure");
  });
});
