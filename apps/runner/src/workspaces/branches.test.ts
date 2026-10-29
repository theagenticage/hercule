/**
 * Tests that the runner lists a main workspace's branches the way the starting
 * revision menu needs them: newest first, filtered by what the user typed, and
 * never more than asked for.
 */
import * as Effect from "effect/Effect";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addBranch,
  buildCheckout,
  buildProvisionFrame,
  cleanTemporaries,
  createId,
  createTemporaryDir,
  makeRemote,
  makeTestWorkspaces,
  runGitOrThrow,
} from "./testing";

afterAll(cleanTemporaries);

/**
 * Makes an empty commit in `cwd` dated `date`, so the order of the list does
 * not depend on how fast the test runs.
 */
const commitAt = (cwd: string, date: string): void => {
  const done = Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", date], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "author@example.invalid",
      GIT_COMMITTER_DATE: date,
    },
  });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
};

/** Provisions a main workspace from a remote with one extra branch, and returns its folder. */
const provisionPrimary = async () => {
  const remote = makeRemote();
  addBranch(remote, "release/1.0");
  const storageDir = createTemporaryDir("hercule-storage-");
  const workspaceId = createId();
  const workspaces = makeTestWorkspaces({ storageDir });
  const report = await Effect.runPromise(
    workspaces.provision(
      buildProvisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [buildCheckout({ resourceId: createId(), remote: remote.url })],
      }),
    ),
  );
  expect(report.status).toBe("ready");
  return { workspaces, workspaceId, folder: join(storageDir, "primaries", workspaceId) };
};

describe("listing the branches of a main workspace", () => {
  it("lists local and remote branches, newest commit first, without the remote's HEAD", async () => {
    const { workspaces, workspaceId, folder } = await provisionPrimary();
    const current = runGitOrThrow(folder, "branch", "--show-current");
    // The other branches were committed to now, which falls between the two.
    for (const [branch, date] of [
      ["fix/older", "2020-01-01T00:00:00Z"],
      ["fix/newer", "2040-01-01T00:00:00Z"],
    ] as const) {
      runGitOrThrow(folder, "checkout", "-q", "-b", branch, current);
      commitAt(folder, date);
    }
    runGitOrThrow(folder, "checkout", "-q", current);

    const outcome = await Effect.runPromise(
      workspaces.listBranches({
        _tag: "branchListRequest",
        requestId: createId(),
        workspaceId,
        text: "",
        maxBranches: 100,
      }),
    );

    expect(outcome).toMatchObject({ status: "listed", more: false });
    if (outcome.status !== "listed") return;
    expect(outcome.local[0]).toBe("fix/newer");
    expect(outcome.local.at(-1)).toBe("fix/older");
    expect([...outcome.local].sort()).toEqual(
      ["fix/newer", "fix/older", current, "main", "release/1.0"].sort(),
    );
    expect([...outcome.remote].sort()).toEqual(["main", "release/1.0"]);
  });

  it("keeps the names that contain the text, ignoring case", async () => {
    const { workspaces, workspaceId, folder } = await provisionPrimary();
    runGitOrThrow(folder, "branch", "Fix-Login");
    runGitOrThrow(folder, "branch", "prefix-fixed");
    runGitOrThrow(folder, "branch", "unrelated");

    const list = (text: string) =>
      Effect.runPromise(
        workspaces.listBranches({
          _tag: "branchListRequest",
          requestId: createId(),
          workspaceId,
          text,
          maxBranches: 100,
        }),
      );

    const fix = await list("fix");
    expect(fix).toMatchObject({ status: "listed", remote: [], more: false });
    if (fix.status === "listed")
      expect([...fix.local].sort()).toEqual(["Fix-Login", "prefix-fixed"]);
    expect(await list("LOGIN")).toEqual({
      status: "listed",
      local: ["Fix-Login"],
      remote: [],
      more: false,
    });
  });

  it("stops at the limit and says that more branches match", async () => {
    const { workspaces, workspaceId, folder } = await provisionPrimary();
    for (const n of [1, 2, 3]) runGitOrThrow(folder, "branch", `topic-${n}`);

    const outcome = await Effect.runPromise(
      workspaces.listBranches({
        _tag: "branchListRequest",
        requestId: createId(),
        workspaceId,
        text: "topic",
        maxBranches: 2,
      }),
    );

    expect(outcome).toMatchObject({ status: "listed", remote: [], more: true });
    if (outcome.status === "listed") expect(outcome.local).toHaveLength(2);
  });

  it("fails with the reason for a workspace this runner does not have", async () => {
    const workspaces = makeTestWorkspaces({ storageDir: createTemporaryDir("hercule-storage-") });
    const workspaceId = createId();

    const outcome = await Effect.runPromise(
      workspaces.listBranches({
        _tag: "branchListRequest",
        requestId: createId(),
        workspaceId,
        text: "",
        maxBranches: 10,
      }),
    );

    expect(outcome).toEqual({
      status: "failed",
      message: `This runner has no ready main workspace \`${workspaceId}\` to list branches from.`,
    });
  });
});
