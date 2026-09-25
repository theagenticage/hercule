/**
 * Runs git for a workspace action, and picks the checkout the action works in.
 *
 * Workspace actions do not use the `runGit` that provisioning uses, because an
 * action can be stopped while git runs: its run is cancelled, or it passes its
 * deadline. So each git process here leads its own process group, and a stop
 * reaches everything git started (a hook, a credential helper), not only git
 * itself. Provisioning's git is never stopped, so it needs none of this.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { buildTailMessage, drainTail } from "../workspaces";
import { WorkspaceActionFailed, type WorkspaceActionContext } from "./action";

/**
 * How long a stopped git process group gets to exit after SIGTERM before it
 * is sent SIGKILL. SIGTERM comes first so git can remove its lock files, such
 * as `index.lock`, which would otherwise block the next step in the checkout.
 */
export const STOP_GRACE: Duration.Duration = Duration.seconds(5);

/** What running git for a workspace action needs: its environment, and how long a stopped git gets before SIGKILL. */
type GitOptions = Pick<WorkspaceActionContext, "gitEnv" | "stopGrace">;

/** How one git process ended: its exit code and the end of each of its outputs. */
export interface GitProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Sends a signal to every process in the child's process group. The child
 * was started as the leader of its own group, which is what makes signalling
 * the negative pid safe.
 */
const signalGroup = (child: Bun.Subprocess, signal: NodeJS.Signals): void => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The whole group has already exited.
  }
};

/** Sends SIGTERM to the child's process group, waits up to `grace` for the child to exit, then sends SIGKILL. */
const stopProcessGroup = (child: Bun.Subprocess, grace: Duration.Duration): Effect.Effect<void> =>
  Effect.gen(function* () {
    signalGroup(child, "SIGTERM");
    yield* Effect.timeoutOption(
      Effect.promise(() => child.exited),
      grace,
    );
    signalGroup(child, "SIGKILL");
  });

/**
 * Runs git with `args` in `dir` and returns how it ended. Never fails on a
 * non-zero exit code: the caller decides what a code means. Git is started
 * from an argument list, never through a shell, so a path or a message is
 * never read as shell syntax.
 *
 * When the effect is interrupted, git's process group is stopped: SIGTERM,
 * then SIGKILL once `options.stopGrace` has passed.
 */
export const runGitProcess = (
  dir: string,
  args: ReadonlyArray<string>,
  options: GitOptions,
): Effect.Effect<GitProcessResult> =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.spawn(["git", "-C", dir, ...args], {
        env: { ...options.gitEnv },
        detached: true,
        // Nobody can type into git on a runner, so it must never wait for input.
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    ),
    (child) =>
      Effect.promise(async () => {
        const stdout = { text: "" };
        const stderr = { text: "" };
        await Promise.all([drainTail(child.stdout, stdout), drainTail(child.stderr, stderr)]);
        return {
          code: await child.exited,
          stdout: stdout.text.trim(),
          stderr: stderr.text.trim(),
        };
      }),
    (child, exit) =>
      Exit.isSuccess(exit) ? Effect.void : stopProcessGroup(child, options.stopGrace),
  );

/**
 * Returns the failure for a git command that exited with an error. The message
 * names the command by its first argument, such as `git commit`, followed by
 * the end of git's error output. Nothing else of git's output is kept.
 */
export const buildGitFailure = (
  args: ReadonlyArray<string>,
  result: GitProcessResult,
): WorkspaceActionFailed =>
  new WorkspaceActionFailed({
    message: buildTailMessage(
      `git ${args[0] ?? ""} failed with exit code ${String(result.code)}:`,
      result.stderr,
    ),
  });

/**
 * Runs git like `runGitProcess`, and fails with `buildGitFailure` when git
 * exits with a code other than zero.
 */
export const runGitOrFail = (
  dir: string,
  args: ReadonlyArray<string>,
  options: GitOptions,
): Effect.Effect<GitProcessResult, WorkspaceActionFailed> =>
  Effect.flatMap(runGitProcess(dir, args, options), (result) =>
    result.code === 0 ? Effect.succeed(result) : Effect.fail(buildGitFailure(args, result)),
  );

/**
 * Returns the directory of the checkout a git action works in: the checkout
 * of the step's resource when the step names one, and otherwise the
 * workspace's only checkout. Fails when there is no such checkout. The
 * controller checks this before it sends the step, so a failure here means the
 * runner's workspace no longer matches what the controller knows.
 */
export const findCheckoutDir = (
  context: WorkspaceActionContext,
): Effect.Effect<string, WorkspaceActionFailed> => {
  const { checkouts } = context.workspace;
  const { resourceId } = context;
  if (resourceId !== undefined) {
    const named = checkouts.find((one) => one.resourceId === resourceId);
    return named === undefined
      ? Effect.fail(
          new WorkspaceActionFailed({
            message: `The run's workspace has no checkout of the resource ${resourceId}. Set the step's resourceId to a resource the workflow's workspace checks out.`,
          }),
        )
      : Effect.succeed(named.path);
  }
  const only = checkouts[0];
  if (checkouts.length === 1 && only !== undefined) return Effect.succeed(only.path);
  return Effect.fail(
    new WorkspaceActionFailed({
      message:
        checkouts.length === 0
          ? "The run's workspace has no checkout, so the action has nothing to work in. Add a checkout to the workflow's workspace."
          : `The run's workspace has ${String(checkouts.length)} checkouts, so the step must name the one it works in. Set the step's resourceId to one of the workspace's resources.`,
    }),
  );
};

/**
 * Switches the step's checkout to `branch`, the way a session start switches
 * it. Fails with git's error output when the switch fails, for example when
 * uncommitted changes would be overwritten.
 *
 * The switch is never forced: a forced switch can throw away the user's
 * uncommitted work in a main workspace, and losing that is worse than failing
 * the step. The `--` ends the options, so git reads `branch` as a branch and
 * never as a path.
 */
export const switchCheckoutBranch = (
  context: WorkspaceActionContext,
  branch: string,
): Effect.Effect<void, WorkspaceActionFailed> =>
  Effect.flatMap(findCheckoutDir(context), (dir) =>
    Effect.asVoid(runGitOrFail(dir, ["checkout", branch, "--"], context)),
  );
