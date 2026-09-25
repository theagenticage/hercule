/**
 * Tests for running workspace steps.
 *
 * Every step runs real git in a real ephemeral workspace, provisioned from a
 * bare "remote" on disk. A step that must stay running blocks in a pre-commit
 * hook until the test creates a release file, so no test waits a fixed time.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { makeWorkspaces, type Workspaces } from "../workspaces";
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
/**
 * Longer than `WAIT_DEADLINE_MS`, so a slow machine fails a test with the
 * wait's message, which names what it waited for, and not with vitest's
 * generic timeout.
 */
const TEST_TIMEOUT_MS = 30_000;

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
  /** The workspaces the steps run in. */
  readonly workspaces: Workspaces;
  /** Every step result the runner sent, in the order it sent them. */
  readonly sent: Array<WorkspaceStepResult>;
  readonly storageDir: string;
  /** The socket git's credential helper is told to connect to. */
  readonly socketPath: string;
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
  /** Installs `script`, a shell script, as the pre-commit hook of this workspace's checkout. */
  readonly writePreCommitHook: (script: string) => void;
  /**
   * Makes every commit in this workspace block in its pre-commit hook until
   * `release` runs. Returns the file the hook writes its process id to once
   * a commit reaches it. With `ignoreSigterm`, the hook and everything it
   * starts ignore SIGTERM, so only SIGKILL ends them.
   */
  readonly blockCommits: (options?: { readonly ignoreSigterm?: boolean }) => {
    readonly reached: string;
    readonly release: () => void;
  };
}

/** Creates a runner's workspace steps, attached to a list that collects what they send. */
const makeRunner = (
  options: { readonly deadline?: Duration.Duration; readonly stopGrace?: Duration.Duration } = {},
): Runner => {
  const storageDir = createTemporaryDir("hercule-storage-");
  const socketPath = join(storageDir, "daemon.sock");
  const workspaces = makeWorkspaces({ storageDir });
  const steps = makeWorkspaceSteps({
    storageDir,
    workspaces,
    socketPath,
    // A home with no git configuration, so the machine's own hooks and
    // identity stay out of the test.
    baseEnv: { PATH: process.env["PATH"], HOME: createTemporaryDir("hercule-home-") },
    ...options,
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
    const writePreCommitHook = (script: string) => {
      const hooksPath = runGitOrThrow(dir, "rev-parse", "--git-path", "hooks");
      const hooks = isAbsolute(hooksPath) ? hooksPath : join(dir, hooksPath);
      mkdirSync(hooks, { recursive: true });
      const hook = join(hooks, "pre-commit");
      writeFileSync(hook, `#!/bin/sh\n${script}\n`);
      chmodSync(hook, 0o755);
    };
    const blockCommits = ({ ignoreSigterm = false } = {}) => {
      const signals = createTemporaryDir("hercule-hook-");
      const reached = join(signals, "reached");
      const released = join(signals, "released");
      writePreCommitHook(
        [
          ...(ignoreSigterm ? ["trap '' TERM"] : []),
          `echo $$ > '${reached}'`,
          `while [ ! -f '${released}' ]; do sleep 0.02; done`,
        ].join("\n"),
      );
      return { reached, release: () => writeFileSync(released, "") };
    };
    return { workspaceId, dir, remote, writePreCommitHook, blockCommits };
  };

  return { steps, workspaces, sent, storageDir, socketPath, provisionWorkspace };
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

describe("git.commit", { timeout: TEST_TIMEOUT_MS }, () => {
  it("commits every change as the step's identity when no paths are given, with git asking this runner for credentials", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    writeFileSync(join(workspace.dir, "README.md"), "changed\n");
    // A hook runs with the environment of the git that runs it, so it can
    // write down what a push's credential helper would be given.
    const seen = join(createTemporaryDir("hercule-hook-"), "environment");
    workspace.writePreCommitHook(
      [
        `echo "$HERCULE_RUNNER_SOCKET" > '${seen}'`,
        `echo "$HERCULE_RUNNER_WORKSPACE" >> '${seen}'`,
        `git config --get-all credential.helper >> '${seen}'`,
      ].join("\n"),
    );

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
    const [socket, workspaceId, ...helpers] = readFileSync(seen, "utf8").trimEnd().split("\n");
    expect(socket).toBe(runner.socketPath);
    expect(workspaceId).toBe(workspace.workspaceId);
    // The machine's own config may name helpers first. The empty helper
    // after them clears them, so git asks only this runner's helper.
    expect(helpers.slice(-2)).toEqual(["", expect.stringMatching(/ git-credential$/)]);
  });

  it("commits only the given paths, and leaves whatever else was staged staged", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    writeFileSync(join(workspace.dir, "b.txt"), "b\n");
    // Staged by someone else sharing the checkout, such as a session in a
    // main workspace.
    writeFileSync(join(workspace.dir, "c.txt"), "c\n");
    runGitOrThrow(workspace.dir, "add", "c.txt");

    const outcome = await runStep(
      runner,
      buildStart(workspace, { message: "Add a only", paths: ["a.txt"] }),
    );

    expect(outcome).toMatchObject({ status: "completed", output: { committed: true } });
    expect(listCommittedFiles(workspace.dir)).toEqual(["a.txt"]);
    expect(runGitOrThrow(workspace.dir, "status", "--porcelain")).toBe("A  c.txt\n?? b.txt");
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

describe("git.push", { timeout: TEST_TIMEOUT_MS }, () => {
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

      expect(outcome).toMatchObject({ status: "failed", code: "action_failed" });
      expect(outcome.status === "failed" && outcome.message).toContain(
        `"${branch}" is not a valid git branch name`,
      );
    }
    expect(runGitOrThrow(workspace.remote.path, "branch", "--list")).toBe("* main");
  });
});

describe("a workspace step with a checkout branch", { timeout: TEST_TIMEOUT_MS }, () => {
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

describe("a workspace step", { timeout: TEST_TIMEOUT_MS }, () => {
  it("runs once however often it is started: a start while it runs is ignored, and one after it finished is answered from its result file", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    const before = runGitOrThrow(workspace.dir, "rev-parse", "HEAD");
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    const hook = workspace.blockCommits();
    const frame = buildStart(workspace, { message: "Add a" });
    await startStep(runner, frame);
    await waitUntil(() => existsSync(hook.reached), "the commit to reach its hook");

    // The controller sends the start again, for example after a reconnect.
    await startStep(runner, frame);
    hook.release();
    const first = await waitForResult(runner, frame);

    expect(listResults(runner, frame)).toEqual([first]);
    expect(runGitOrThrow(workspace.dir, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
    const head = runGitOrThrow(workspace.dir, "rev-parse", "HEAD");
    // A change that a second run would commit.
    writeFileSync(join(workspace.dir, "b.txt"), "b\n");

    await startStep(runner, frame);

    // The start is answered before it returns, because the file is read at once.
    expect(listResults(runner, frame)).toEqual([first, first]);
    expect(runGitOrThrow(workspace.dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("deletes a finished step's result file when the step is stopped, and ignores a later start of it", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    const frame = buildStart(workspace, { message: "Add a" });
    await runStep(runner, frame);
    const file = join(
      runner.storageDir,
      "step-results",
      workspace.workspaceId,
      `${frame.runId}-commit-1.json`,
    );
    expect(existsSync(file)).toBe(true);
    const head = runGitOrThrow(workspace.dir, "rev-parse", "HEAD");

    await Effect.runPromise(runner.steps.stop({ _tag: "workspaceStepStop", steps: [frame] }));

    // The controller stops a step once it has recorded how the step ended.
    expect(existsSync(file)).toBe(false);
    // The step already sent its result, so the stop sends nothing more.
    expect(listResults(runner, frame)).toHaveLength(1);

    // A start that reaches the runner after the step's stop, with a change
    // in the checkout that running the step again would commit.
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    await startStep(runner, frame);

    expect(runner.steps.listInFlight()).toEqual([]);
    expect(listResults(runner, frame)).toHaveLength(1);
    expect(runGitOrThrow(workspace.dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("stops its git's whole process group when the step is stopped, with SIGKILL once the grace period has passed, and answers interrupted", async () => {
    const runner = makeRunner({ stopGrace: Duration.millis(300) });
    const workspace = await runner.provisionWorkspace();
    const before = runGitOrThrow(workspace.dir, "rev-parse", "HEAD");
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    // The hook ignores SIGTERM, so only the SIGKILL after the grace period
    // ends it.
    const hook = workspace.blockCommits({ ignoreSigterm: true });
    const frame = buildStart(workspace, { message: "Never lands" });
    await startStep(runner, frame);
    const readHookPid = () => (existsSync(hook.reached) ? readFileSync(hook.reached, "utf8") : "");
    await waitUntil(() => readHookPid().endsWith("\n"), "the commit to reach its hook");
    const hookPid = Number(readHookPid());
    const isHookAlive = () => {
      try {
        process.kill(hookPid, 0);
        return true;
      } catch {
        return false;
      }
    };

    try {
      await Effect.runPromise(runner.steps.stop({ _tag: "workspaceStepStop", steps: [frame] }));
      const outcome = await waitForResult(runner, frame);

      expect(outcome).toMatchObject({ status: "failed", code: "interrupted" });
      // The hook is a child of git, so only a signal to git's whole process
      // group reaches it.
      await waitUntil(() => !isHookAlive(), "the hook to be killed");
      expect(runGitOrThrow(workspace.dir, "rev-parse", "HEAD")).toBe(before);
      expect(runner.steps.listInFlight()).toEqual([]);
      // A stopped step leaves no result file behind.
      const results = join(runner.storageDir, "step-results", workspace.workspaceId);
      expect(existsSync(join(results, `${frame.runId}-commit-1.json`))).toBe(false);
    } finally {
      hook.release();
    }
  });

  it("sends no result when its workspace failed to provision, and fails when this runner never had its workspace", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    const failing = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: createId(),
          remote: makeRemote().url,
          branch: BRANCH,
          setupCommand: "exit 3",
        }),
      ],
    });
    // As the controller sends them: the step right after its workspace's
    // provisioning, while the provisioning is still running.
    const inFailed = {
      ...buildStart(workspace, { message: "Add a" }),
      workspaceId: failing.workspaceId,
    };
    const [report] = await Promise.all([
      runner.workspaces.provision(failing),
      startStep(runner, inFailed),
    ]);
    await waitUntil(() => runner.steps.listInFlight().length === 0, "the step to be dropped");

    // The failed report ends the run with the setup's own message, so the
    // step sends nothing that could reach the controller first.
    expect(report.status).toBe("failed");
    expect(listResults(runner, inFailed)).toEqual([]);

    // No workspace report will ever end this one, so its result must.
    const inUnknown = { ...buildStart(workspace, { message: "Add a" }), workspaceId: createId() };
    const outcome = await runStep(runner, inUnknown);

    expect(outcome).toMatchObject({ status: "failed", code: "action_failed" });
    expect(outcome.status === "failed" && outcome.message).toContain(inUnknown.workspaceId);
  });

  it("fails with timeout when its action runs past the deadline", async () => {
    const runner = makeRunner({ deadline: Duration.millis(300) });
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
