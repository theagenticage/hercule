/**
 * Tests workspace steps through the shipped program: a workflow run whose
 * `git.commit` and `git.push` steps run in a workspace made for the run on the
 * machine the controller runs for itself, and whose push is reached through
 * an edge that reads the commit's sha.
 *
 * Nothing here contacts a network. The repository is a bare one in a
 * temporary directory, reached through git's own `url.<base>.insteadOf`
 * written into the machine's `HOME`, as in `e2e/workspace.test.ts`. The
 * resource's setup command writes the file the step commits, because no
 * agent step exists yet to change anything in the workspace.
 *
 * The commit's author is git's own identity from that `HOME`, not the
 * workspace's designated Connection. A GitHub Connection can only be created
 * by asking GitHub who its token belongs to, which needs the network and a
 * real account. The integration tests in
 * `apps/controller/src/daemon/runs/workspace-steps.integration.test.ts` check
 * that the step frame carries the Connection's identity, and
 * `apps/runner/src/workspace-actions/steps.test.ts` checks that the commit is
 * made as the identity in the frame.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` runs it and
 * `pnpm test` does not. It runs the release binary if one has been built, and
 * the dispatcher's source otherwise.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  runCli,
  completeSetup,
  buildGitEnv,
  parseJsonOutputOrFail,
  findReleaseBinary,
  startController,
  createTemporaryHome,
  waitForEnrolledRunner,
  type Controller,
  type Ran,
} from "./harness";

const state = createTemporaryHome();
/** Holds the bare remote. */
const world = createTemporaryHome();
const binary = findReleaseBinary();

/** The identity the machine's git commits as when a step frame carries none. */
const MACHINE_NAME = "Machine Git";
const MACHINE_EMAIL = "machine@hercule.test";

/**
 * The `HOME` both the machine's git and the test's own git read, and nothing
 * else: the default branch, and the identity the machine commits as.
 */
const gitHome = createTemporaryHome(
  `[init]\n\tdefaultBranch = main\n[user]\n\tname = ${MACHINE_NAME}\n\temail = ${MACHINE_EMAIL}\n`,
);

const bare = join(world.home, "remote.git");

/** How long a clone, a setup command and a commit may take on a cold machine. */
const RUN_DEADLINE_MS = 90_000;

let controller: Controller;
/** The runner the controller starts for itself, where the run's workspace is made. */
let runnerId: string;

const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  runCli(args, { home: state.home, binary, stdin });

/** Runs git with none of the developer's configuration, and returns its trimmed stdout. */
const runGit = (args: ReadonlyArray<string>, cwd: string): string => {
  const ran = Bun.spawnSync(["git", ...args], { cwd, env: buildGitEnv(gitHome.home) });
  if (ran.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}:\n${ran.stderr.toString()}`);
  }
  return ran.stdout.toString().trim();
};

interface StepRecord {
  readonly stepId: string;
  readonly status: string;
  readonly output?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

interface Run {
  readonly id: string;
  readonly status: string;
  readonly failureReason?: string;
  readonly failedStepId?: string;
  readonly runnerId?: string;
  readonly workspaceId?: string;
  readonly steps: ReadonlyArray<StepRecord>;
}

/** Reads a run until it has ended, and returns it. Throws with the controller's output at the deadline. */
const waitForRunToEnd = async (runId: string): Promise<Run> => {
  const deadline = Date.now() + RUN_DEADLINE_MS;
  for (;;) {
    const run = parseJsonOutputOrFail<Run>(await runLoggedInCli(["run", "read", runId, "--json"]));
    if (run.status !== "pending" && run.status !== "running") return run;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} was still ${run.status} after ${String(RUN_DEADLINE_MS)}ms:\n` +
          `${JSON.stringify(run.steps)}\n${controller.output()}`,
      );
    }
    await Bun.sleep(250);
  }
};

/** Records a repo that resolves to the bare repository, filed under a new project. */
const createRepo = async (remote: string, setupCommand: string): Promise<string> => {
  appendFileSync(
    join(gitHome.home, ".gitconfig"),
    `[url "file://${bare}"]\n\tinsteadOf = ${remote}\n`,
  );
  const project = parseJsonOutputOrFail<{ readonly id: string }>(
    await runLoggedInCli(["project", "create", "--name", `Project for ${remote}`, "--json"]),
  );
  const resource = parseJsonOutputOrFail<{ readonly id: string }>(
    await runLoggedInCli([
      "resource",
      "create",
      "--kind",
      "repo",
      "--remote",
      remote,
      "--setup-command",
      setupCommand,
      "--project",
      project.id,
      "--json",
    ]),
  );
  return resource.id;
};

/**
 * Stores a workflow that commits in an ephemeral workspace with one checkout
 * of `resourceId`, pushes the commit, then files a task titled with the
 * commit's sha. The edge to the push holds only when the sha is a full
 * 40-character sha, so a completed push shows the commit step's output
 * reached the edge. Returns the workflow's id.
 */
const createCommitWorkflow = async (resourceId: string): Promise<string> => {
  const source = [
    "name: Commit what setup wrote",
    "workspace:",
    "  kind: ephemeral",
    "  checkouts:",
    `    - resourceId: ${resourceId}`,
    "steps:",
    "  - id: commit",
    "    kind: action",
    "    action: git.commit",
    "    params:",
    "      message: Save what setup wrote",
    "  - id: push",
    "    kind: action",
    "    action: git.push",
    "  - id: file_task",
    "    kind: action",
    "    action: task.create",
    "    params:",
    '      title: "Committed {{ steps.commit.output.sha }}"',
    "      description: Filed after the commit.",
    "edges:",
    "  - from: commit",
    "    to: push",
    "    condition: size(steps.commit.output.sha) == 40",
    "  - from: push",
    "    to: file_task",
    "",
  ].join("\n");
  return parseJsonOutputOrFail<{ readonly workflow: { readonly id: string } }>(
    await runLoggedInCli(["workflow", "create", "--json"], source),
  ).workflow.id;
};

/** Starts a run of a stored workflow, and returns the run's id. */
const startRun = async (workflowId: string): Promise<string> =>
  parseJsonOutputOrFail<{ readonly runId: string }>(
    await runLoggedInCli(["run", "start", "--workflow", workflowId, "--json"]),
  ).runId;

/** Returns `<home>/runner/<storage>`, the runner's storage directory. */
const readStorageDir = (): string => {
  const pin = JSON.parse(readFileSync(join(state.home, "runner", "runner.json"), "utf8")) as {
    readonly storageDirectory: string;
  };
  return join(state.home, "runner", pin.storageDirectory);
};

beforeAll(async () => {
  // A bare repository with one commit on `main`.
  runGit(["init", "--bare", "--initial-branch=main", bare], world.home);
  const seed = join(world.home, "seed");
  mkdirSync(seed);
  runGit(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, "README.md"), "hercule e2e\n");
  runGit(["add", "README.md"], seed);
  runGit(["commit", "-m", "one commit"], seed);
  runGit(["push", bare, "main"], seed);

  controller = await startController({
    home: state.home,
    binary,
    // The machine's git reads this `HOME`, and nothing of the developer's.
    env: { HOME: gitHome.home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  const completed = await completeSetup({ home: state.home, url: controller.url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runLoggedInCli(
    [
      "login",
      controller.url,
      "--username",
      USERNAME,
      "--password-stdin",
      "--name",
      "e2e-workspace-steps",
    ],
    PASSWORD,
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  // Runs of this workflow wait for a runner rather than fail, so the test
  // waits for the machine first: a run that never finds one would only time out.
  runnerId = await waitForEnrolledRunner({ home: state.home, binary });
}, 150_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state.remove();
  world.remove();
  gitHome.remove();
});

describe("a run with git.commit and git.push steps in its own workspace", () => {
  it(
    "commits what the setup command wrote on the run's branch, routes on the commit's sha, and pushes the branch",
    async () => {
      const resourceId = await createRepo(
        "https://hercule.test/acme/commit",
        "echo from-setup > setup.txt",
      );
      const runId = await startRun(await createCommitWorkflow(resourceId));

      const run = await waitForRunToEnd(runId);
      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.runnerId).toBe(runnerId);
      expect(run.workspaceId).toBeDefined();
      const commit = run.steps.find((record) => record.stepId === "commit");
      expect(commit).toMatchObject({
        status: "completed",
        output: { branch: `hercule/run-${runId}`, committed: true },
      });
      const sha = commit!.output!["sha"] as string;
      // The edge's condition held, so the push ran and pushed the same commit.
      expect(run.steps.find((record) => record.stepId === "push")).toMatchObject({
        status: "completed",
        output: { branch: `hercule/run-${runId}`, sha },
      });
      expect(run.steps.find((record) => record.stepId === "file_task")).toMatchObject({
        status: "completed",
        output: { title: `Committed ${sha}` },
      });

      // The commit is on the run's branch in the runner's copy of the
      // repository, holds the file the setup command wrote, and sits on top
      // of the remote's `main`.
      const cache = join(readStorageDir(), "cache", `${resourceId}.git`);
      expect(runGit(["rev-parse", `hercule/run-${runId}`], cache)).toBe(sha);
      expect(runGit(["show", "--no-patch", "--format=%an <%ae>|%s", sha], cache)).toBe(
        `${MACHINE_NAME} <${MACHINE_EMAIL}>|Save what setup wrote`,
      );
      expect(runGit(["show", "--name-only", "--format=", sha], cache)).toBe("setup.txt");
      expect(runGit(["show", `${sha}:setup.txt`], cache)).toBe("from-setup");
      expect(runGit(["rev-parse", `${sha}^`], cache)).toBe(runGit(["rev-parse", "main"], bare));

      // The push put the run's branch on the remote, pointing at the commit.
      expect(runGit(["rev-parse", `refs/heads/hercule/run-${runId}`], bare)).toBe(sha);
    },
    RUN_DEADLINE_MS + 30_000,
  );

  it(
    "fails with workspace-failed at the commit step when the setup command fails",
    async () => {
      const resourceId = await createRepo(
        "https://hercule.test/acme/broken-setup",
        "echo setup-went-wrong >&2; exit 3",
      );
      const runId = await startRun(await createCommitWorkflow(resourceId));

      const run = await waitForRunToEnd(runId);
      expect(run).toMatchObject({
        status: "failed",
        failureReason: "workspace-failed",
        failedStepId: "commit",
      });
      const commit = run.steps.find((record) => record.stepId === "commit");
      expect(commit?.status).toBe("failed");
      expect(commit?.error?.code).toBe("workspace_failed");
      expect(commit?.error?.message).toContain("setup-went-wrong");
      // The edge never fired: nothing after the failed step ran.
      expect(run.steps.some((record) => record.stepId !== "commit")).toBe(false);
    },
    RUN_DEADLINE_MS + 30_000,
  );
});

/**
 * Stores a workflow that commits in an ephemeral workspace with one checkout
 * of `resourceId`, then runs `then`, the source lines of one more step with
 * the id `after`. Returns the workflow's id.
 */
const createCommitThenWorkflow = async (
  resourceId: string,
  then: ReadonlyArray<string>,
): Promise<string> => {
  const source = [
    "name: Commit, then one more step",
    "workspace:",
    "  kind: ephemeral",
    "  checkouts:",
    `    - resourceId: ${resourceId}`,
    "steps:",
    "  - id: commit",
    "    kind: action",
    "    action: git.commit",
    "    params:",
    "      message: Save what setup wrote",
    "  - id: after",
    ...then,
    "edges:",
    "  - from: commit",
    "    to: after",
    "",
  ].join("\n");
  return parseJsonOutputOrFail<{ readonly workflow: { readonly id: string } }>(
    await runLoggedInCli(["workflow", "create", "--json"], source),
  ).workflow.id;
};

interface Workspace {
  readonly status: string;
  readonly keptUntil: string | null;
  readonly disposedAt: string | null;
}

const readWorkspace = async (workspaceId: string): Promise<Workspace> =>
  parseJsonOutputOrFail<Workspace>(
    await runLoggedInCli(["workspace", "read", workspaceId, "--json"]),
  );

/*
 * The workspace sweep that deletes a completed run's workspace runs every ten
 * minutes, and the shipped program has no setting to shorten that, so the
 * completed-run rule is covered by the sweep's integration tests in
 * `apps/controller/src/daemon/workspaces/provisioning.integration.test.ts`.
 * Here the workspace is deleted by hand, which needs no sweep.
 */
describe("the workspace of a run that failed or has not finished", () => {
  it(
    "keeps a failed run's workspace ready until workspace.dispose deletes it",
    async () => {
      const resourceId = await createRepo(
        "https://hercule.test/acme/kept",
        "echo from-setup > setup.txt",
      );
      // The second step updates a task that does not exist, so it fails.
      const workflowId = await createCommitThenWorkflow(resourceId, [
        "    kind: action",
        "    action: task.update",
        "    params:",
        "      taskId: 0199c0ff-7777-7000-8000-000000000001",
        "      title: Never",
      ]);
      const runId = await startRun(workflowId);

      const run = await waitForRunToEnd(runId);
      expect(run).toMatchObject({ status: "failed", failedStepId: "after" });
      expect(run.steps.find((record) => record.stepId === "commit")?.status).toBe("completed");
      const workspaceId = run.workspaceId!;
      const kept = await readWorkspace(workspaceId);
      expect(kept).toMatchObject({ status: "ready", disposedAt: null });
      expect(kept.keptUntil).not.toBeNull();

      const disposed = await runLoggedInCli(["workspace", "dispose", workspaceId]);
      expect(disposed.code, `${disposed.stdout}\n${disposed.stderr}`).toBe(0);
      const deleted = await readWorkspace(workspaceId);
      expect(deleted.status).toBe("deleted");
      expect(deleted.disposedAt).not.toBeNull();
    },
    RUN_DEADLINE_MS + 30_000,
  );

  it(
    "refuses workspace.dispose while the run has not finished, and says to cancel the run first",
    async () => {
      const resourceId = await createRepo(
        "https://hercule.test/acme/unfinished",
        "echo from-setup > setup.txt",
      );
      // The second step waits for an hour, so the run is still running.
      const runId = await startRun(
        await createCommitThenWorkflow(resourceId, [
          "    kind: action",
          "    action: wait",
          "    params:",
          "      seconds: 3600",
        ]),
      );

      const deadline = Date.now() + RUN_DEADLINE_MS;
      let run: Run;
      for (;;) {
        run = parseJsonOutputOrFail<Run>(await runLoggedInCli(["run", "read", runId, "--json"]));
        if (run.steps.some((record) => record.stepId === "after")) break;
        if (Date.now() > deadline)
          throw new Error(`the commit never finished:\n${JSON.stringify(run)}`);
        await Bun.sleep(250);
      }
      expect(run.status).toBe("running");

      const refused = await runLoggedInCli(["workspace", "dispose", run.workspaceId!]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(`cancel run ${runId} first`);
      expect((await readWorkspace(run.workspaceId!)).status).toBe("ready");

      const cancelled = await runLoggedInCli(["run", "cancel", runId]);
      expect(cancelled.code, `${cancelled.stdout}\n${cancelled.stderr}`).toBe(0);
    },
    RUN_DEADLINE_MS + 30_000,
  );
});
