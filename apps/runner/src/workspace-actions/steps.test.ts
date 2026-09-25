/**
 * Tests for running workspace steps.
 *
 * Every step runs real git in a real ephemeral workspace, provisioned from a
 * bare "remote" on disk. A step that must stay running blocks in a pre-commit
 * hook until the test creates a release file, so no test waits a fixed time.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type {
  WorkspaceStepKey,
  WorkspaceStepOutcome,
  WorkspaceStepResult,
  WorkspaceStepStart,
} from "@hercule/protocol";
import { makeWorkspaces } from "../workspaces";
import {
  addBranch,
  buildCheckout,
  buildProvisionFrame,
  cleanTemporaries,
  createId,
  createTemporaryDir,
  makeRemote,
  runGitOrThrow,
  type Remote,
} from "../workspaces/testing";
import { makeWorkspaceSteps, type WorkspaceSteps } from "./steps";

afterAll(cleanTemporaries);

const BRANCH = "hercule/run-3f1a2b4c";
const IDENTITY = { name: "Hercule Bot", email: "bot@example.invalid" };
const WAIT_DEADLINE_MS = 20_000;

/** Scopes that attach a test's steps to its list of sent results; closed after each test. */
const attachments: Array<Scope.Closeable> = [];

afterEach(async () => {
  for (const scope of attachments.splice(0)) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

/** Polls `ready` until it returns true, and fails the test when the wait deadline passes first. */
const waitUntil = async (ready: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ready(), `timed out waiting for ${what}`).toBe(true);
};

interface Runner {
  readonly steps: WorkspaceSteps;
  /** Every step result the runner sent, in the order it sent them. */
  readonly sent: Array<WorkspaceStepResult>;
  readonly storageDir: string;
  /**
   * Provisions a workspace with one checkout of a new remote, and returns it.
   * An ephemeral one is on `BRANCH`; a primary is on the remote's `main`.
   */
  readonly provisionWorkspace: (kind?: "ephemeral" | "primary") => Promise<Workspace>;
}

interface Workspace {
  readonly workspaceId: string;
  readonly dir: string;
  /** The bare repository the workspace's one checkout was cloned from. */
  readonly remote: Remote;
  /**
   * Makes every commit in this workspace block in its pre-commit hook until
   * `release` runs. Returns the file the hook creates once a commit reaches it.
   */
  readonly blockCommits: () => { readonly reached: string; readonly release: () => void };
}

/** Creates a runner's workspace steps, attached to a list that collects what they send. */
const makeRunner = (deadline?: Duration.Duration): Runner => {
  const storageDir = createTemporaryDir("hercule-storage-");
  const workspaces = makeWorkspaces({ storageDir });
  const steps = makeWorkspaceSteps({
    storageDir,
    workspaces,
    socketPath: join(storageDir, "daemon.sock"),
    // A home with no git configuration, so the machine's own hooks and
    // identity stay out of the test.
    baseEnv: { PATH: process.env["PATH"], HOME: createTemporaryDir("hercule-home-") },
    ...(deadline === undefined ? {} : { deadline }),
  });
  const sent: Array<WorkspaceStepResult> = [];
  const scope = Effect.runSync(Scope.make());
  attachments.push(scope);
  Effect.runSync(
    steps.attached((frame) => Effect.sync(() => void sent.push(frame))).pipe(Scope.provide(scope)),
  );

  const provisionWorkspace = async (
    kind: "ephemeral" | "primary" = "ephemeral",
  ): Promise<Workspace> => {
    const workspaceId = createId();
    const resourceId = createId();
    const remote = makeRemote();
    const report = await workspaces.provision(
      buildProvisionFrame({
        workspaceId,
        kind,
        checkouts: [
          kind === "ephemeral"
            ? buildCheckout({ resourceId, remote: remote.url, branch: BRANCH })
            : buildCheckout({ resourceId, remote: remote.url }),
        ],
      }),
    );
    expect(report.status).toBe("ready");
    const dir =
      kind === "ephemeral"
        ? join(storageDir, "workspaces", workspaceId)
        : join(storageDir, "primaries", resourceId);
    const blockCommits = () => {
      const signals = createTemporaryDir("hercule-hook-");
      const reached = join(signals, "reached");
      const released = join(signals, "released");
      const hooksPath = runGitOrThrow(dir, "rev-parse", "--git-path", "hooks");
      const hooks = isAbsolute(hooksPath) ? hooksPath : join(dir, hooksPath);
      mkdirSync(hooks, { recursive: true });
      const hook = join(hooks, "pre-commit");
      writeFileSync(
        hook,
        `#!/bin/sh\ntouch '${reached}'\nwhile [ ! -f '${released}' ]; do sleep 0.02; done\n`,
      );
      chmodSync(hook, 0o755);
      return { reached, release: () => writeFileSync(released, "") };
    };
    return { workspaceId, dir, remote, blockCommits };
  };

  return { steps, sent, storageDir, provisionWorkspace };
};

const buildStart = (
  workspace: Workspace,
  input: WorkspaceStepStart["input"],
  action = "git.commit",
): WorkspaceStepStart => ({
  _tag: "workspaceStepStart",
  runId: createId(),
  stepId: "commit",
  iteration: 1,
  workspaceId: workspace.workspaceId,
  action,
  input,
  gitIdentity: IDENTITY,
});

const isSameStep = (frame: WorkspaceStepKey, key: WorkspaceStepKey): boolean =>
  frame.runId === key.runId && frame.stepId === key.stepId && frame.iteration === key.iteration;

const listResults = (runner: Runner, key: WorkspaceStepKey): ReadonlyArray<WorkspaceStepOutcome> =>
  runner.sent.filter((frame) => isSameStep(frame, key)).map((frame) => frame.outcome);

/** Starts a step. Does not wait for it to finish. */
const startStep = (runner: Runner, frame: WorkspaceStepStart): Promise<void> =>
  Effect.runPromise(runner.steps.start(frame));

/** Waits for the step's first result and returns it. */
const waitForResult = async (
  runner: Runner,
  key: WorkspaceStepKey,
): Promise<WorkspaceStepOutcome> => {
  await waitUntil(() => listResults(runner, key).length > 0, `the result of step ${key.runId}`);
  return listResults(runner, key)[0]!;
};

/** Starts a step and returns its result. */
const runStep = async (
  runner: Runner,
  frame: WorkspaceStepStart,
): Promise<WorkspaceStepOutcome> => {
  await startStep(runner, frame);
  return waitForResult(runner, frame);
};

const listCommittedFiles = (dir: string): ReadonlyArray<string> =>
  runGitOrThrow(dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort();

describe("git.commit", () => {
  it("commits every change as the step's identity when no paths are given", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    writeFileSync(join(workspace.dir, "README.md"), "changed\n");

    const outcome = await runStep(runner, buildStart(workspace, { message: "Add a" }));

    const head = runGitOrThrow(workspace.dir, "rev-parse", "HEAD");
    expect(outcome).toEqual({
      status: "completed",
      output: { sha: head, branch: BRANCH, committed: true },
    });
    expect(listCommittedFiles(workspace.dir)).toEqual(["README.md", "a.txt"]);
    expect(runGitOrThrow(workspace.dir, "log", "-1", "--format=%an <%ae>|%s")).toBe(
      "Hercule Bot <bot@example.invalid>|Add a",
    );
  });

  it("commits only the given paths", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    writeFileSync(join(workspace.dir, "b.txt"), "b\n");

    const outcome = await runStep(
      runner,
      buildStart(workspace, { message: "Add a only", paths: ["a.txt"] }),
    );

    expect(outcome.status).toBe("completed");
    expect(listCommittedFiles(workspace.dir)).toEqual(["a.txt"]);
    expect(runGitOrThrow(workspace.dir, "status", "--porcelain")).toBe("?? b.txt");
  });

  it("reports committed: false and the current commit when there is nothing to commit", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    const before = runGitOrThrow(workspace.dir, "rev-parse", "HEAD");

    const outcome = await runStep(runner, buildStart(workspace, { message: "Nothing" }));

    expect(outcome).toEqual({
      status: "completed",
      output: { sha: before, branch: BRANCH, committed: false },
    });
    expect(runGitOrThrow(workspace.dir, "rev-parse", "HEAD")).toBe(before);
  });
});

/** Returns the sha a completed `git.commit` step reports. */
const readCommittedSha = (outcome: WorkspaceStepOutcome): string => {
  expect(outcome.status).toBe("completed");
  return outcome.status === "completed" ? (outcome.output as { sha: string }).sha : "";
};

describe("git.push", () => {
  it("pushes the checkout's branch to its remote under the same name, and sets the upstream", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    const sha = readCommittedSha(
      await runStep(runner, buildStart(workspace, { message: "Add a" })),
    );

    const outcome = await runStep(runner, buildStart(workspace, {}, "git.push"));

    expect(outcome).toEqual({ status: "completed", output: { branch: BRANCH, sha } });
    expect(runGitOrThrow(workspace.remote.path, "rev-parse", `refs/heads/${BRANCH}`)).toBe(sha);
    expect(runGitOrThrow(workspace.dir, "config", `branch.${BRANCH}.remote`)).toBe("origin");
    expect(runGitOrThrow(workspace.dir, "config", `branch.${BRANCH}.merge`)).toBe(
      `refs/heads/${BRANCH}`,
    );
  });

  it("pushes the branch its params name rather than the current one", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    runGitOrThrow(workspace.dir, "branch", "feature");
    const feature = runGitOrThrow(workspace.dir, "rev-parse", "feature");

    const outcome = await runStep(runner, buildStart(workspace, { branch: "feature" }, "git.push"));

    expect(outcome).toEqual({ status: "completed", output: { branch: "feature", sha: feature } });
    expect(runGitOrThrow(workspace.remote.path, "rev-parse", "refs/heads/feature")).toBe(feature);
    expect(runGitOrThrow(workspace.remote.path, "branch", "--list", BRANCH)).toBe("");
  });

  it("never forces: a push the remote refuses as a non-fast-forward fails with git's error output", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    // The remote's branch of the same name holds a commit the checkout does
    // not have, so a forced push would throw that commit away.
    const theirs = addBranch(workspace.remote, BRANCH);
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    readCommittedSha(await runStep(runner, buildStart(workspace, { message: "Add a" })));

    const outcome = await runStep(runner, {
      ...buildStart(workspace, {}, "git.push"),
      stepId: "push",
    });

    expect(outcome).toMatchObject({ status: "failed", code: "action_failed" });
    expect(outcome.status === "failed" && outcome.message).toContain("git push failed");
    expect(outcome.status === "failed" && outcome.message).toContain("rejected");
    expect(runGitOrThrow(workspace.remote.path, "rev-parse", `refs/heads/${BRANCH}`)).toBe(theirs);
  });

  it("refuses a branch name git would not accept, or would read as something else, and pushes nothing", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();

    for (const branch of ["--force", "a..b", "@{-1}", "main:elsewhere"]) {
      const outcome = await runStep(runner, buildStart(workspace, { branch }, "git.push"));

      expect(outcome).toEqual({
        status: "failed",
        code: "action_failed",
        message: `"${branch}" is not a valid branch name`,
      });
    }
    expect(runGitOrThrow(workspace.remote.path, "branch", "--list")).toBe("* main");
  });
});

describe("a workspace step with a checkout branch", () => {
  it("switches the checkout to that branch before its action runs", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace("primary");
    runGitOrThrow(workspace.dir, "branch", "feature");
    const main = runGitOrThrow(workspace.dir, "rev-parse", "main");
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");

    const outcome = await runStep(runner, {
      ...buildStart(workspace, { message: "Add a" }),
      checkoutBranch: "feature",
    });

    expect(outcome).toMatchObject({ status: "completed", output: { branch: "feature" } });
    expect(runGitOrThrow(workspace.dir, "log", "-1", "--format=%s", "feature")).toBe("Add a");
    expect(runGitOrThrow(workspace.dir, "rev-parse", "main")).toBe(main);
  });

  it("fails with action_failed and git's error output when the switch fails", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace("primary");

    const outcome = await runStep(runner, {
      ...buildStart(workspace, { message: "Add a" }),
      checkoutBranch: "no-such-branch",
    });

    expect(outcome).toMatchObject({ status: "failed", code: "action_failed" });
    expect(outcome.status === "failed" && outcome.message).toContain("no-such-branch");
  });
});

describe("a workspace step", () => {
  it("answers a repeated start from its result file, without committing again", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    const frame = buildStart(workspace, { message: "Add a" });
    const first = await runStep(runner, frame);
    const head = runGitOrThrow(workspace.dir, "rev-parse", "HEAD");
    // A change that a second run would commit.
    writeFileSync(join(workspace.dir, "b.txt"), "b\n");

    await startStep(runner, frame);

    // The start is answered before it returns, because the file is read at once.
    expect(listResults(runner, frame)).toEqual([first, first]);
    expect(runGitOrThrow(workspace.dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("deletes a finished step's result file when the step is stopped", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    const frame = buildStart(workspace, { message: "Nothing" });
    await runStep(runner, frame);
    const file = join(
      runner.storageDir,
      "step-results",
      workspace.workspaceId,
      `${frame.runId}-commit-1.json`,
    );
    expect(existsSync(file)).toBe(true);

    await Effect.runPromise(runner.steps.stop({ _tag: "workspaceStepStop", steps: [frame] }));

    // The controller stops a step once it has recorded how the step ended.
    expect(existsSync(file)).toBe(false);
    // The step already sent its result, so the stop sends nothing more.
    expect(listResults(runner, frame)).toHaveLength(1);
  });

  it("stops its git when the step is stopped, and answers interrupted", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    const before = runGitOrThrow(workspace.dir, "rev-parse", "HEAD");
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    const hook = workspace.blockCommits();
    const frame = buildStart(workspace, { message: "Never lands" });
    await startStep(runner, frame);
    await waitUntil(() => existsSync(hook.reached), "the commit to reach its hook");

    try {
      await Effect.runPromise(runner.steps.stop({ _tag: "workspaceStepStop", steps: [frame] }));
      const outcome = await waitForResult(runner, frame);

      expect(outcome).toMatchObject({ status: "failed", code: "interrupted" });
      expect(runGitOrThrow(workspace.dir, "rev-parse", "HEAD")).toBe(before);
      expect(runner.steps.listInFlight()).toEqual([]);
      // A stopped step leaves no result file behind, so a later start runs it again.
      const results = join(runner.storageDir, "step-results", workspace.workspaceId);
      expect(existsSync(join(results, `${frame.runId}-commit-1.json`))).toBe(false);
    } finally {
      hook.release();
    }
  });

  it("fails with timeout when its action runs past the deadline", async () => {
    const runner = makeRunner(Duration.millis(300));
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    const hook = workspace.blockCommits();

    try {
      const outcome = await runStep(runner, buildStart(workspace, { message: "Too slow" }));

      expect(outcome).toMatchObject({ status: "failed", code: "timeout" });
      expect(outcome.status === "failed" && outcome.message).toContain("git.commit");
    } finally {
      hook.release();
    }
  });

  it("runs the steps of one workspace one at a time, and other workspaces' steps meanwhile", async () => {
    const runner = makeRunner();
    const first = await runner.provisionWorkspace();
    const other = await runner.provisionWorkspace();
    writeFileSync(join(first.dir, "a.txt"), "a\n");
    writeFileSync(join(first.dir, "b.txt"), "b\n");
    writeFileSync(join(other.dir, "c.txt"), "c\n");
    const hook = first.blockCommits();
    const stepA = buildStart(first, { message: "Add a", paths: ["a.txt"] });
    const stepB = { ...buildStart(first, { message: "Add b", paths: ["b.txt"] }), stepId: "b" };
    const stepC = buildStart(other, { message: "Add c" });

    try {
      await startStep(runner, stepA);
      await waitUntil(() => existsSync(hook.reached), "step A to reach its hook");
      await startStep(runner, stepB);
      const outcomeC = await runStep(runner, stepC);

      expect(outcomeC.status).toBe("completed");
      // Step B waits behind step A. It would otherwise have failed on git's
      // index lock, which step A holds.
      expect(listResults(runner, stepB)).toEqual([]);
      expect(runner.steps.listInFlight()).toEqual([
        { runId: stepA.runId, stepId: "commit", iteration: 1 },
        { runId: stepB.runId, stepId: "b", iteration: 1 },
      ]);
    } finally {
      hook.release();
    }

    expect((await waitForResult(runner, stepA)).status).toBe("completed");
    expect((await waitForResult(runner, stepB)).status).toBe("completed");
    expect(runGitOrThrow(first.dir, "log", "-2", "--format=%s")).toBe("Add b\nAdd a");
    expect(runner.steps.listInFlight()).toEqual([]);
  });

  it("answers an action this runner does not implement with unsupported_action", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();

    const outcome = await runStep(runner, buildStart(workspace, {}, "git.teleport"));

    expect(outcome).toMatchObject({ status: "failed", code: "unsupported_action" });
    expect(outcome.status === "failed" && outcome.message).toContain("git.teleport");
  });

  it("fails with action_failed when the checkout's git fails", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");

    const outcome = await runStep(
      runner,
      buildStart(workspace, { message: "Add", paths: ["missing.txt"] }),
    );

    // The message ends with git's own error output.
    expect(outcome).toMatchObject({ status: "failed", code: "action_failed" });
    expect(outcome.status === "failed" && outcome.message).toContain("missing.txt");
  });
});
