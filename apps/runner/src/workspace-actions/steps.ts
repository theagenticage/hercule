/**
 * Runs the workspace steps the controller sends: one action per step, in the
 * run's workspace on this runner, and sends back how each step ended.
 *
 * Steps belong to the process, not to a connection: a step keeps running
 * while the runner reconnects. Its result is sent on whichever connection is
 * up when it finishes. With no connection at that moment, the step's result
 * file is the record, and the controller's start sent again on reconnect is
 * answered from it.
 */
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import {
  type ActionStepStart,
  MAX_MESSAGE_LENGTH,
  type WorkspaceStepKey,
  type WorkspaceStepOutcome,
  type WorkspaceStepResult,
  type WorkspaceStepStart,
  type WorkspaceStepSettle,
} from "@hercule/protocol";
import { buildGitCredentialEnv, RUNNER_WORKSPACE_VARIABLE } from "../credentials";
import { describeCause } from "../report";
import { buildSubstrateEnv, type Workspaces } from "../workspaces";
import type { WorkspaceAction } from "./action";
import { STOP_GRACE, switchCheckoutBranch } from "./git";
import { findWorkspaceAction } from "./registry";
import { buildStepName, deleteStepResult, readStepResult, writeStepResult } from "./results";

/** How long one workspace action may run before it is stopped and its step fails with `timeout`. */
export const ACTION_DEADLINE: Duration.Duration = Duration.minutes(10);

/**
 * How many settled steps this runner remembers, to ignore a start of one that
 * arrives after its settle. Such a start is at most a few frames late, so the
 * most recent settles are the ones that matter, and the oldest is forgotten
 * first.
 */
const REMEMBERED_SETTLED = 1024;

type Send = (frame: WorkspaceStepResult) => Effect.Effect<void, unknown>;

/**
 * The workspace steps this runner holds, for the connection to the controller
 * to drive: it passes on each step start and settle it receives, attaches
 * itself to receive the results, and lists the steps in flight when it
 * reconnects.
 */
export interface WorkspaceSteps {
  /**
   * Sends step results through `send` for as long as the scope is open. A
   * result finished while no connection is attached is not sent; its result
   * file answers the controller's next start of the step.
   */
  readonly attachConnection: (send: Send) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Starts a step, unless this runner already knows it:
   *
   * - a step that was settled is ignored, because the controller has
   *   already recorded how it ended;
   * - a step that is queued or running is left alone;
   * - a step that finished is answered from its result file;
   * - any other step is queued behind the steps of its workspace and run.
   *
   * An action this runner does not implement is answered at once with
   * `unsupported_action`. An agent step is answered at once with
   * `session_failed`, because this runner build does not run agent steps
   * yet; it does not list the agent steps capability, so a controller never
   * sends one.
   */
  readonly start: (frame: WorkspaceStepStart) => Effect.Effect<void>;
  /**
   * Settles the listed steps: the controller no longer owes them, because
   * their records have ended. For each step:
   *
   * - a running step's git is stopped and the step is answered with
   *   `interrupted`; a queued step is dropped without an answer;
   * - its result file is deleted. For a finished step that is all that
   *   happens: the controller settles every step whose end it has recorded,
   *   to say it will not ask for that result again;
   * - its key is remembered, so a later start of the step is ignored.
   */
  readonly settle: (frame: WorkspaceStepSettle) => Effect.Effect<void>;
  /** Returns the key of every step that is queued or running now. */
  readonly listInFlight: () => ReadonlyArray<WorkspaceStepKey>;
}

/** A step this runner has started and not yet finished. */
interface HeldStep {
  readonly key: WorkspaceStepKey;
  readonly workspaceId: string;
  /** Queued behind another step of its workspace, or running its action. */
  phase: "queued" | "running";
  /** Set once the step has written its result, so a settle that raced it sends no second answer. */
  finished: boolean;
  /** Set by the first stop of the step. */
  stopping: boolean;
  fiber: Fiber.Fiber<void> | undefined;
}

const buildResultFrame = (
  key: WorkspaceStepKey,
  outcome: WorkspaceStepOutcome,
): WorkspaceStepResult => ({
  _tag: "workspaceStepResult",
  runId: key.runId,
  stepId: key.stepId,
  iteration: key.iteration,
  outcome,
});

const readKey = (frame: WorkspaceStepKey): WorkspaceStepKey => ({
  runId: frame.runId,
  stepId: frame.stepId,
  iteration: frame.iteration,
});

/**
 * Creates the workspace steps of this runner. Call it once per process: the
 * steps it holds outlive the connection that started them.
 */
export const makeWorkspaceSteps = (options: {
  readonly storageDir: string;
  readonly workspaces: Workspaces;
  /** The socket the git credential helper connects to when it asks this runner for credentials. */
  readonly socketPath: string;
  /** The runner's own environment. Git's environment is built on top of it. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Defaults to `ACTION_DEADLINE`. Tests set a shorter one. */
  readonly deadline?: Duration.Duration;
  /** Defaults to `STOP_GRACE`. Tests set a shorter one. */
  readonly stopGrace?: Duration.Duration;
}): WorkspaceSteps => {
  const { storageDir, workspaces } = options;
  const deadline = options.deadline ?? ACTION_DEADLINE;
  const stopGrace = options.stopGrace ?? STOP_GRACE;
  const held = new Map<string, HeldStep>();
  /**
   * The names of the steps settled most recently, oldest first. A start and
   * a settle of one step can reach this runner in the wrong order, and a step
   * the controller has settled must never run afterwards: its end is already
   * recorded, and a push would be made that no run knows about.
   */
  const settled = new Set<string>();
  /**
   * One lock per workspace with a step queued or running. The steps of one
   * workspace run one at a time, because two git processes in one checkout
   * collide on `index.lock`. Steps of different workspaces run side by side.
   */
  const locks = new Map<string, Semaphore.Semaphore>();
  let sending: Send | undefined;

  const send = (frame: WorkspaceStepResult): Effect.Effect<void> =>
    sending === undefined ? Effect.void : Effect.ignoreCause(sending(frame));

  /**
   * Returns the lock of a workspace, and creates it when no step of that
   * workspace holds one yet.
   */
  const ensureWorkspaceLock = (workspaceId: string): Semaphore.Semaphore => {
    const known = locks.get(workspaceId);
    if (known !== undefined) return known;
    const made = Semaphore.makeUnsafe(1);
    locks.set(workspaceId, made);
    return made;
  };

  /** Forgets a step, and its workspace's lock once no step of that workspace is left. */
  const releaseStep = (step: HeldStep): void => {
    const name = buildStepName(step.key);
    if (held.get(name) === step) held.delete(name);
    if (![...held.values()].some((other) => other.workspaceId === step.workspaceId)) {
      locks.delete(step.workspaceId);
    }
  };

  /**
   * Runs the step's action and returns how the step ended. Never fails: a
   * failed action, a timeout and a defect all become a failed outcome.
   *
   * Returns undefined, and runs nothing, when the latest provisioning of the
   * step's workspace on this runner failed. The step then gets no result: the
   * failed workspace report fails the run at this step with the
   * provisioning's own error message, such as the setup command's output. A
   * result sent here could reach the controller first and fail the run with
   * a message that hides that error.
   */
  const runAction = (
    frame: ActionStepStart,
    action: WorkspaceAction,
  ): Effect.Effect<WorkspaceStepOutcome | undefined> =>
    Effect.gen(function* () {
      // The controller sends a step right after its workspace's provisioning
      // frame, and the provisioning may still be cloning.
      yield* Effect.promise(() => workspaces.waitForProvisioning(frame.workspaceId));
      if (workspaces.hasFailedProvisioning(frame.workspaceId)) return undefined;
      const workspace = workspaces.resolve(frame.workspaceId);
      // Never had, lost or disposed: no workspace report ends the step then,
      // so its result must, or the run would wait for it forever.
      if (workspace === undefined) {
        return {
          status: "failed",
          code: "action_failed",
          message: `This runner does not hold the run's workspace ${frame.workspaceId}, so the step could not run. Start the run again.`,
        } as const;
      }
      // Built the way a session's environment is built, so a commit is made
      // as the same account a session in this workspace commits as. No
      // session runs the step, so git's credential helper asks as the
      // runner, naming the workspace: the controller answers that while a
      // workspace step of the workspace runs on this runner.
      const gitEnv = {
        ...buildSubstrateEnv(options.baseEnv),
        ...buildGitCredentialEnv({ socketPath: options.socketPath, identity: frame.gitIdentity }),
        [RUNNER_WORKSPACE_VARIABLE]: frame.workspaceId,
      };
      const context = { workspace, resourceId: frame.resourceId, gitEnv, stopGrace };
      const { checkoutBranch } = frame;
      // A main workspace is shared, so something else may have switched its
      // checkout since the run's last step. The switch runs here, under the
      // workspace's lock, so no other step's git runs in between.
      const switched =
        checkoutBranch === undefined ? Effect.void : switchCheckoutBranch(context, checkoutBranch);
      const ran = yield* switched.pipe(
        Effect.flatMap(() => action.run(frame.input, context)),
        Effect.map((output): WorkspaceStepOutcome => ({ status: "completed", output })),
        Effect.catchTag("WorkspaceActionFailed", (failure) =>
          Effect.succeed<WorkspaceStepOutcome>({
            status: "failed",
            code: "action_failed",
            message: failure.message.slice(0, MAX_MESSAGE_LENGTH),
          }),
        ),
        // A bug in the action still ends the step, or the run would wait
        // for a result that never comes.
        Effect.catchDefect((defect) =>
          Effect.succeed<WorkspaceStepOutcome>({
            status: "failed",
            code: "action_failed",
            message: describeCause(Cause.die(defect), MAX_MESSAGE_LENGTH),
          }),
        ),
        // A timeout interrupts the action, which stops its git.
        Effect.timeoutOption(deadline),
      );
      return Option.getOrElse(ran, (): WorkspaceStepOutcome => ({
        status: "failed",
        code: "timeout",
        message: `The action ${frame.action} was still running after ${Duration.format(deadline)}, so it was stopped.`,
      }));
    });

  /**
   * Writes the step's result file, forgets the step, then sends its result.
   * The file is written before the step is forgotten, so a start sent again
   * at any moment finds the step either still held or finished on disk.
   */
  const finishStep = (step: HeldStep, outcome: WorkspaceStepOutcome): Effect.Effect<void> =>
    Effect.gen(function* () {
      try {
        writeStepResult(storageDir, step.workspaceId, step.key, outcome);
      } catch {
        // The result is still sent. Without the file, a start sent again
        // after a lost result runs the step again, as after a crash.
      }
      step.finished = true;
      releaseStep(step);
      yield* send(buildResultFrame(step.key, outcome));
    });

  /**
   * Runs a held step: waits for its workspace's lock, runs its action, then
   * writes, forgets and sends its result. A step whose workspace failed to
   * provision is forgotten with no result. Never fails; a settle
   * interrupts it.
   */
  const runStep = (
    frame: ActionStepStart,
    action: WorkspaceAction,
    step: HeldStep,
  ): Effect.Effect<void> =>
    ensureWorkspaceLock(step.workspaceId)
      .withPermits(1)(
        Effect.suspend(() => {
          step.phase = "running";
          return runAction(frame, action);
        }),
      )
      .pipe(
        Effect.flatMap((outcome) =>
          outcome === undefined
            ? Effect.sync(() => releaseStep(step))
            : Effect.uninterruptible(finishStep(step, outcome)),
        ),
      );

  /**
   * Stops one held step, then forgets it. A running step is answered with
   * `interrupted`, unless it finished on its own while the settle was on
   * its way: that step already sent its result.
   */
  const stopStep = (step: HeldStep): Effect.Effect<void> =>
    Effect.gen(function* () {
      // A second stop of the same step, while the first is still stopping
      // git, must not answer the step a second time.
      if (step.stopping) return;
      step.stopping = true;
      const wasRunning = step.phase === "running";
      if (step.fiber !== undefined) yield* Fiber.interrupt(step.fiber);
      releaseStep(step);
      if (!wasRunning || step.finished) return;
      yield* send(
        buildResultFrame(step.key, {
          status: "failed",
          code: "interrupted",
          message: "The step was stopped before it finished.",
        }),
      );
    });

  return {
    attachConnection: (sendResult) =>
      Effect.asVoid(
        Effect.acquireRelease(
          Effect.sync(() => {
            sending = sendResult;
          }),
          () =>
            Effect.sync(() => {
              if (sending === sendResult) sending = undefined;
            }),
        ),
      ),

    start: (frame) =>
      Effect.gen(function* () {
        const key = readKey(frame);
        if (frame.kind === "agent") {
          return yield* send(
            buildResultFrame(key, {
              status: "failed",
              code: "session_failed",
              message:
                "This runner cannot run agent steps, because its build does not implement them. Update the runner to the controller's version.",
            }),
          );
        }
        const name = buildStepName(key);
        if (settled.has(name) || held.has(name)) return;
        const recorded = readStepResult(storageDir, frame.workspaceId, key);
        if (recorded !== undefined) return yield* send(buildResultFrame(key, recorded));
        const action = findWorkspaceAction(frame.action);
        if (action === undefined) {
          // Answered at once and not written down: asking again gives the same answer.
          return yield* send(
            buildResultFrame(key, {
              status: "failed",
              code: "unsupported_action",
              message: `This runner cannot run the action ${frame.action}, because its build does not implement it. Update the runner to the controller's version.`,
            }),
          );
        }
        // No trace of the step: it never ran here, or the runner crashed
        // while it ran and before its result file was written. Running it
        // again is safe for every action this runner has:
        //
        // - `git.commit`: in a checkout that already has the commit, nothing
        //   is left to stage, so the step succeeds with `committed: false`
        //   and HEAD, which is that commit;
        // - `git.push`: a remote that already has the branch's commit
        //   accepts the same push again and changes nothing.
        const step: HeldStep = {
          key,
          workspaceId: frame.workspaceId,
          phase: "queued",
          finished: false,
          stopping: false,
          fiber: undefined,
        };
        held.set(name, step);
        step.fiber = yield* Effect.forkDetach(runStep(frame, action, step));
      }),

    settle: (frame) =>
      Effect.gen(function* () {
        for (const key of frame.steps) {
          // Deleted whether the step is running or long finished: the
          // controller never asks again for the result of a step it settles.
          deleteStepResult(storageDir, key);
          const name = buildStepName(key);
          settled.delete(name);
          settled.add(name);
          if (settled.size > REMEMBERED_SETTLED) settled.delete(settled.values().next().value!);
          const step = held.get(name);
          // Detached, because stopping git can take the full grace period,
          // and the connection must go on handling frames meanwhile.
          if (step !== undefined) yield* Effect.forkDetach(stopStep(step));
        }
      }),

    listInFlight: () => [...held.values()].map((step) => step.key),
  };
};
