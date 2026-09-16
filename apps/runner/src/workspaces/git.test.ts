/**
 * The git calls a workspace is made of, against real repositories.
 *
 * What is asserted here is what a user would find afterwards: an edit they had
 * not committed, a branch that is still theirs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { switchBranch } from "./git";
import { addBranch, userCheckout, cleanTemporaries, git, makeRemote } from "./testing";

afterAll(cleanTemporaries);

const ENV: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

describe("switching a checkout to a branch", () => {
  it("switches to the branch that was named", async () => {
    const remote = makeRemote();
    addBranch(remote, "release");
    const folder = userCheckout(remote);

    const outcome = await switchBranch(folder, "release", ENV);

    expect(outcome.ok).toBe(true);
    expect(git(folder, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
  });

  it("refuses a name that is a file rather than a branch, and keeps the edit under it", async () => {
    const remote = makeRemote();
    const folder = userCheckout(remote);
    // The user's uncommitted work, in a file whose name could be read as a
    // branch: `git checkout README.md` would silently restore it from HEAD.
    writeFileSync(join(folder, "README.md"), "what the user was in the middle of\n");

    const outcome = await switchBranch(folder, "README.md", ENV);

    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain("README.md");
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe(
      "what the user was in the middle of\n",
    );
  });
});
