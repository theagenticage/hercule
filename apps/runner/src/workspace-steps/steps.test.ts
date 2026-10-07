/**
 * Tests for running workspace steps.
 *
 * Every action step runs real git in a real ephemeral workspace, provisioned
 * from a bare "remote" on disk. A step that must stay running blocks in a
 * pre-commit hook until the test creates a release file, so no test waits a
 * fixed time. An agent step's turn is played by the test, which begins and
 * finishes the step the way the session supervisor does.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type {
  ActionStepStart,
  AgentStepResultRequest,
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
    // identity stay out of the test. HERCULE_HOME stands for the runner's own
    // Home, which a step's git and hooks must never see.
    baseEnv: {
      PATH: process.env["PATH"],
      HOME: createTemporaryDir("hercule-home-"),
      HERCULE_HOME: "/home/somebody/.hercule",
    },
    ...options,
  });
  const sent: Array<WorkspaceStepResult> = [];
  const scope = Effect.runSync(Scope.make());
  attachments.push(scope);
  Effect.runSync(
    steps
      .attachConnection((frame) => Effect.sync(() => void sent.push(frame)))
      .pipe(Scope.provide(scope)),
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
    const dir = workspaces.resolve(workspaceId)!.cwd;
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
  input: ActionStepStart["input"],
  action = "git.commit",
): ActionStepStart => ({
  _tag: "workspaceStepStart",
  kind: "action",
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
    // write down what a push's credential helper would be given, and whether
    // the runner's own HERCULE_HOME reached the step.
    const seen = join(createTemporaryDir("hercule-hook-"), "environment");
    workspace.writePreCommitHook(
      [
        `echo "$HERCULE_RUNNER_SOCKET" > '${seen}'`,
        `echo "$HERCULE_RUNNER_WORKSPACE" >> '${seen}'`,
        `echo "$HERCULE_HOME" >> '${seen}'`,
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
    const [socket, workspaceId, home, ...helpers] = readFileSync(seen, "utf8")
      .trimEnd()
      .split("\n");
    expect(socket).toBe(runner.socketPath);
    expect(workspaceId).toBe(workspace.workspaceId);
    expect(home).toBe("");
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

  it("deletes a finished step's result file when the step is settled, and ignores a later start of it", async () => {
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

    await Effect.runPromise(runner.steps.settle({ _tag: "workspaceStepSettle", steps: [frame] }));

    // The controller settles a step once it has recorded how the step ended.
    expect(existsSync(file)).toBe(false);
    // The step already sent its result, so the settle sends nothing more.
    expect(listResults(runner, frame)).toHaveLength(1);

    // A start that reaches the runner after the step's settle, with a change
    // in the checkout that running the step again would commit.
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    await startStep(runner, frame);

    expect(runner.steps.listInFlight()).toEqual([]);
    expect(listResults(runner, frame)).toHaveLength(1);
    expect(runGitOrThrow(workspace.dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("stops its git's whole process group when a running step is settled, with SIGKILL once the grace period has passed, and answers interrupted", async () => {
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
      await Effect.runPromise(runner.steps.settle({ _tag: "workspaceStepSettle", steps: [frame] }));
      const outcome = await waitForResult(runner, frame);

      expect(outcome).toMatchObject({ status: "failed", code: "interrupted" });
      // The hook is a child of git, so only a signal to git's whole process
      // group reaches it.
      await waitUntil(() => !isHookAlive(), "the hook to be killed");
      expect(runGitOrThrow(workspace.dir, "rev-parse", "HEAD")).toBe(before);
      expect(runner.steps.listInFlight()).toEqual([]);
      // A settled step leaves no result file behind.
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

  it("holds back a step started after the workspace's first step ended, while the step that took over the lock runs", async () => {
    const runner = makeRunner();
    const first = await runner.provisionWorkspace();
    const other = await runner.provisionWorkspace();
    writeFileSync(join(first.dir, "a.txt"), "a\n");
    writeFileSync(join(first.dir, "b.txt"), "b\n");
    writeFileSync(join(first.dir, "c.txt"), "c\n");
    writeFileSync(join(other.dir, "d.txt"), "d\n");
    // Each commit blocks in the hook until the test releases the file it
    // commits, so step A can end while step B stays blocked.
    const signals = createTemporaryDir("hercule-hook-");
    first.writePreCommitHook(
      [
        "name=$(git diff --cached --name-only)",
        `touch "${signals}/reached-$name"`,
        `while [ ! -f "${signals}/released-$name" ]; do sleep 0.02; done`,
      ].join("\n"),
    );
    const hasReached = (name: string) => existsSync(join(signals, `reached-${name}`));
    const release = (name: string) => writeFileSync(join(signals, `released-${name}`), "");
    const stepA = buildStart(first, { message: "Add a", paths: ["a.txt"] });
    const stepB = { ...buildStart(first, { message: "Add b", paths: ["b.txt"] }), stepId: "b" };
    const stepC = { ...buildStart(first, { message: "Add c", paths: ["c.txt"] }), stepId: "c" };
    const stepD = buildStart(other, { message: "Add d" });

    try {
      await startStep(runner, stepA);
      await waitUntil(() => hasReached("a.txt"), "step A to reach its hook");
      await startStep(runner, stepB);
      release("a.txt");
      expect((await waitForResult(runner, stepA)).status).toBe("completed");
      await waitUntil(() => hasReached("b.txt"), "step B to reach its hook");

      // Step A has ended and step B holds the lock. Step C must wait for B.
      await startStep(runner, stepC);
      // Step D, in another workspace, finishes without waiting: proof that
      // step C had time to reach its hook, had it not waited.
      expect((await runStep(runner, stepD)).status).toBe("completed");
      expect(hasReached("c.txt")).toBe(false);
      expect(listResults(runner, stepC)).toEqual([]);
    } finally {
      for (const name of ["a.txt", "b.txt", "c.txt"]) release(name);
    }

    expect((await waitForResult(runner, stepB)).status).toBe("completed");
    expect((await waitForResult(runner, stepC)).status).toBe("completed");
    expect(runGitOrThrow(first.dir, "log", "-3", "--format=%s")).toBe("Add c\nAdd b\nAdd a");
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

const buildAgentStart = (workspaceId: string | null): AgentStepResultRequest => ({
  _tag: "workspaceStepStart",
  kind: "agent",
  runId: createId(),
  stepId: "review",
  iteration: 1,
  sessionId: "0199e0e7-0000-7000-8000-0000000000a1",
  workspaceId,
});

const REVIEWED: WorkspaceStepOutcome = { status: "completed", output: { verdict: "approve" } };

/**
 * Begins the agent step, with a turn that runs for as long as `running`
 * returns true. Returns whether the step was recorded.
 */
const beginAgentStep = (
  runner: Runner,
  frame: AgentStepResultRequest,
  running: () => boolean = () => true,
): Promise<boolean> =>
  Effect.runPromise(runner.steps.beginAgentStep(frame, frame.workspaceId, Effect.sync(running)));

const finishAgentStep = (
  runner: Runner,
  key: WorkspaceStepKey,
  outcome: WorkspaceStepOutcome = REVIEWED,
): Promise<void> => Effect.runPromise(runner.steps.finishAgentStep(key, outcome));

const settleSteps = (runner: Runner, ...steps: ReadonlyArray<WorkspaceStepKey>): Promise<void> =>
  Effect.runPromise(
    runner.steps.settle({
      _tag: "workspaceStepSettle",
      steps: steps.map(({ runId, stepId, iteration }) => ({ runId, stepId, iteration })),
    }),
  );

describe("an agent step", { timeout: TEST_TIMEOUT_MS }, () => {
  it("sends its result when its turn ends, and answers a start sent again from its result file", async () => {
    const runner = makeRunner();
    const frame = buildAgentStart(createId());
    expect(await beginAgentStep(runner, frame)).toBe(true);
    expect(runner.steps.listInFlight()).toEqual([
      { runId: frame.runId, stepId: "review", iteration: 1 },
    ]);

    await finishAgentStep(runner, frame);

    expect(listResults(runner, frame)).toEqual([REVIEWED]);
    expect(runner.steps.listInFlight()).toEqual([]);
    await startStep(runner, frame);
    expect(listResults(runner, frame)).toEqual([REVIEWED, REVIEWED]);
  });

  it("keeps the result of a step with no workspace, and answers a start sent again from it", async () => {
    const runner = makeRunner();
    const frame = buildAgentStart(null);
    await beginAgentStep(runner, frame);
    await finishAgentStep(runner, frame);

    expect(
      existsSync(
        join(runner.storageDir, "step-results", ".no-workspace", `${frame.runId}-review-1.json`),
      ),
    ).toBe(true);
    await startStep(runner, frame);
    expect(listResults(runner, frame)).toEqual([REVIEWED, REVIEWED]);
  });

  it("answers a start sent while its turn runs only once the turn ends", async () => {
    const runner = makeRunner();
    const frame = buildAgentStart(createId());
    await beginAgentStep(runner, frame);

    await startStep(runner, frame);
    expect(listResults(runner, frame)).toEqual([]);

    await finishAgentStep(runner, frame);
    expect(listResults(runner, frame)).toEqual([REVIEWED]);
  });

  it("answers interrupted when this runner knows nothing of the step, as after a restart", async () => {
    const runner = makeRunner();
    const frame = buildAgentStart(createId());

    await startStep(runner, frame);

    expect(listResults(runner, frame)).toEqual([
      expect.objectContaining({ status: "failed", code: "interrupted" }),
    ]);
  });

  it("answers interrupted when its session ended unseen, and sends nothing for it after that", async () => {
    const runner = makeRunner();
    const frame = buildAgentStart(createId());
    await beginAgentStep(runner, frame, () => false);

    await startStep(runner, frame);
    await finishAgentStep(runner, frame);

    expect(listResults(runner, frame)).toEqual([
      expect.objectContaining({ status: "failed", code: "interrupted" }),
    ]);
    expect(runner.steps.listInFlight()).toEqual([]);
  });

  it("deletes its result file when settled, and ignores a later start of it", async () => {
    const runner = makeRunner();
    const workspaceId = createId();
    const frame = buildAgentStart(workspaceId);
    await beginAgentStep(runner, frame);
    await finishAgentStep(runner, frame);

    await settleSteps(runner, frame);
    await startStep(runner, frame);

    expect(listResults(runner, frame)).toEqual([REVIEWED]);
    const results = join(runner.storageDir, "step-results", workspaceId);
    expect(existsSync(join(results, `${frame.runId}-review-1.json`))).toBe(false);
  });

  it("sends nothing and writes nothing when its turn ends after it was settled", async () => {
    const runner = makeRunner();
    const frame = buildAgentStart(null);
    await beginAgentStep(runner, frame);

    await settleSteps(runner, frame);
    expect(runner.steps.listInFlight()).toEqual([]);
    await finishAgentStep(runner, frame);
    // The settled step is not recorded again, and the supervisor is told so,
    // so it does not run the step's prompt.
    expect(await beginAgentStep(runner, frame)).toBe(false);
    await finishAgentStep(runner, frame);

    expect(runner.sent).toEqual([]);
    expect(runner.steps.listInFlight()).toEqual([]);
    expect(existsSync(join(runner.storageDir, "step-results", ".no-workspace"))).toBe(false);
  });

  it("sends nothing when it begins, even when this runner already holds a result for it", async () => {
    const runner = makeRunner();
    const frame = buildAgentStart(createId());
    await beginAgentStep(runner, frame);
    await finishAgentStep(runner, frame);

    // The controller sends a step's input at most once, so beginning a step
    // never answers for it: only the end of its turn, or a request for its
    // result, sends one.
    await beginAgentStep(runner, frame);

    expect(listResults(runner, frame)).toEqual([REVIEWED]);
    expect(runner.steps.listInFlight()).toEqual([
      { runId: frame.runId, stepId: "review", iteration: 1 },
    ]);
  });

  it("is forgotten without an answer when the harness refuses its input", async () => {
    const runner = makeRunner();
    const frame = buildAgentStart(createId());
    await beginAgentStep(runner, frame);

    runner.steps.forgetAgentStep(frame);
    await finishAgentStep(runner, frame);

    expect(runner.sent).toEqual([]);
    expect(runner.steps.listInFlight()).toEqual([]);
  });

  it("takes no workspace lock: a commit in its workspace runs while its turn runs", async () => {
    const runner = makeRunner();
    const workspace = await runner.provisionWorkspace();
    writeFileSync(join(workspace.dir, "a.txt"), "a\n");
    const agent = buildAgentStart(workspace.workspaceId);
    await beginAgentStep(runner, agent);

    const commit = await runStep(runner, buildStart(workspace, { message: "Add a" }));

    expect(commit.status).toBe("completed");
    expect(runner.steps.listInFlight()).toEqual([
      { runId: agent.runId, stepId: "review", iteration: 1 },
    ]);
    await finishAgentStep(runner, agent);
    expect(listResults(runner, agent)).toEqual([REVIEWED]);
  });
});
