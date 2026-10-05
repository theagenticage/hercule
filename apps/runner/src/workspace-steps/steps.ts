/**
 * Holds the workspace steps of this runner and sends back how each one ended:
 *
 * - an action step runs one workspace action, in the run's workspace on this
 *   runner;
 * - an agent step is a turn of a session on this runner. The session
 *   supervisor runs the turn and reports its end here; this module only keeps
 *   track of the step and its result.
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
  type AgentStepResultRequest,
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
import {
  STOP_GRACE,
  findWorkspaceAction,
  switchCheckoutBranch,
  type WorkspaceAction,
} from "../workspace-actions";
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
   * Starts an action step, unless this runner already knows it:
   *
   * - a step that was settled is ignored, because the controller has
   *   already recorded how it ended;
   * - a step that is queued or running is left alone;
   * - a step that finished is answered from its result file;
   * - any other step is queued behind the steps of its workspace and run.
   *
   * An action this runner does not implement is answered at once with
   * `unsupported_action`.
   *
   * For an agent step the frame only asks for the result, because a session
   * input started the step's turn. Such a step is:
   *
   * - ignored once settled, like an action step;
   * - left alone while its turn still runs, because the turn's end answers it;
   * - answered from its result file once the turn has ended;
   * - otherwise answered at once with `interrupted`, because this runner has
   *   no record of the turn: the runner restarted, the session ended while
   *   the runner was disconnected and could not see it end, or the step's
   *   input never reached this runner.
   */
  readonly start: (frame: WorkspaceStepStart) => Effect.Effect<void>;
  /**
   * Settles the listed steps: the controller no longer owes them, because
   * their records have ended. For each step:
   *
   * - a running action step's git is stopped and the step is answered with
   *   `interrupted`; a queued action step is dropped without an answer;
   * - an agent step is forgotten, so the end of its turn sends nothing. Its
   *   session is not stopped here: stopping it is the controller's call;
   * - its result file is deleted. For a finished step that is all that
   *   happens: the controller settles every step whose end it has recorded,
   *   to say it will not ask for that result again;
   * - its key is remembered, so a later start of the step is ignored.
   */
  readonly settle: (frame: WorkspaceStepSettle) => Effect.Effect<void>;
  /** Returns the key of every step that is queued or running now, of both kinds. */
  readonly listInFlight: () => ReadonlyArray<WorkspaceStepKey>;
  /**
   * Records that an agent step's turn is about to run, in a session in the
   * given workspace, or in a session with no workspace when it is null. The
   * session supervisor calls this before the step's input reaches the
   * harness, so the turn cannot end before the step is recorded here.
   *
   * `isTurnRunning` checks whether the turn still runs in a session this
   * runner hosts. A request for the step's result waits for the turn only
   * while it returns true.
   *
   * The controller sends a step's input at most once, because a second turn
   * could push or comment a second time, so this does not look for a turn or
   * a result the step already has.
   *
   * Returns true when the step was recorded. Returns false, and records
   * nothing, when the step was already settled: the settle can overtake the
   * step's input when the run ends just as the input is sent. The caller must
   * then not run the step's turn, because a turn of a run that has ended
   * could still push or comment.
   */
  readonly beginAgentStep: (
    key: WorkspaceStepKey,
    workspaceId: string | null,
    isTurnRunning: Effect.Effect<boolean>,
  ) => Effect.Effect<boolean>;
  /**
   * Saves how an agent step ended in its result file, forgets the step, then
   * sends the result. Does nothing for a step that is not recorded, because
   * it was settled or already answered with `interrupted`.
   */
  readonly finishAgentStep: (
    key: WorkspaceStepKey,
    outcome: WorkspaceStepOutcome,
  ) => Effect.Effect<void>;
  /**
   * Forgets an agent step and sends no answer. The supervisor calls this when
   * the harness refuses the step's input: no turn ran, and the controller
   * delivers the input again later.
   */
  readonly forgetAgentStep: (key: WorkspaceStepKey) => void;
  /**
   * Runs `effect` while holding the lock of a workspace, so that no action
   * step of that workspace runs git at the same time. A session start uses
   * it to switch the workspace's branch.
   *
   * Waits at most `maxWait` for the lock. Returns none, and runs nothing,
   * when the lock is still held after that. `maxWait` bounds only the wait:
   * once `effect` has begun, it runs to its end. Fails with the error of
   * `effect`.
   */
  readonly runUnderWorkspaceLock: <A, E>(
    workspaceId: string,
    maxWait: Duration.Duration,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<Option.Option<A>, E>;
}

/** An action step this runner has started and not yet finished. */
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

/** An agent step whose turn runs in a session on this runner, or ran there and was not answered yet. */
interface AgentStep {
  readonly key: WorkspaceStepKey;
  readonly workspaceId: string | null;
  readonly isTurnRunning: Effect.Effect<boolean>;
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

/**
 * How an agent step ends when this runner has no record of its turn. The
 * runner never runs the step's prompt again on its own: the lost turn may
 * already have made changes, such as a push, that a second turn would repeat.
 */
const AGENT_TURN_UNKNOWN: WorkspaceStepOutcome = {
  status: "failed",
  code: "interrupted",
  message:
    "The runner has no record of this step's turn: the runner restarted, the step's session ended while the runner was disconnected from the controller, or the runner never received the step's prompt.",
};

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
   * The agent steps whose turn runs, by name. They are kept apart from the
   * action steps because they take no workspace lock. Sessions may work side
   * by side in one workspace (spec 07 section 4.4), and an agent's turn can
   * run for hours, which would hold up every commit in the workspace.
   */
  const agentSteps = new Map<string, AgentStep>();
  /**
   * The names of the steps settled most recently, oldest first. A start and
   * a settle of one step can reach this runner in the wrong order, and a step
   * the controller has settled must never run afterwards: its end is already
   * recorded, and a push would be made that no run knows about.
   */
  const settled = new Set<string>();
  /**
   * One lock per workspace that has a step, or a session start's branch
   * switch, waiting for its lock or holding it. The git work of one workspace
   * runs one at a time, because two git processes in one checkout collide on
   * `index.lock`. Steps of different workspaces run side by side.
   *
   * `users` counts what waits for the lock or holds it.
   */
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  let sending: Send | undefined;

  const send = (frame: WorkspaceStepResult): Effect.Effect<void> =>
    sending === undefined ? Effect.void : Effect.ignoreCause(sending(frame));

  /**
   * Waits for the lock of a workspace, then runs `effect` while holding it.
   * Creates the lock when nothing uses it yet, and forgets it once nothing
   * waits for it or holds it. A lock forgotten while something still waited
   * for it would let the next step create a second lock, and the two would
   * run git side by side.
   */
  const holdWorkspaceLock = <A, E>(
    workspaceId: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const lock = locks.get(workspaceId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        lock.users += 1;
        locks.set(workspaceId, lock);
        return lock;
      }),
      (lock) => lock.semaphore.withPermits(1)(effect),
      (lock) =>
        Effect.sync(() => {
          lock.users -= 1;
          if (lock.users === 0) locks.delete(workspaceId);
        }),
    );

  /** Forgets a step. */
  const releaseStep = (step: HeldStep): void => {
    const name = buildStepName(step.key);
    if (held.get(name) === step) held.delete(name);
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
      // The controller sets the branch only on a run's first workspace step,
      // to start the run on its workflow's branch. The switch runs here,
      // under the workspace's lock, so no other step's git runs in between.
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
   * Writes a step's result file, calls `forget` to drop the step from what
   * this runner holds, then sends the result. The file is written before the
   * step is forgotten, so a start sent again at any moment finds the step
   * either still held or finished on disk.
   *
   * A failed write does not stop the result from being sent. Without the
   * file, a start sent again after a lost result is answered as for a step
   * this runner never heard of: an action step runs again, as after a crash,
   * and an agent step is answered with `interrupted`.
   */
  const saveAndSendResult = (
    workspaceId: string | null,
    key: WorkspaceStepKey,
    outcome: WorkspaceStepOutcome,
    forget: () => void,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      try {
        writeStepResult(storageDir, workspaceId, key, outcome);
      } catch {
        // Sent anyway: a result the controller receives is worth more than
        // the file, which only answers a start sent again.
      }
      forget();
      return send(buildResultFrame(key, outcome));
    });

  /** Saves the result of an action step, forgets the step, then sends the result. */
  const finishStep = (step: HeldStep, outcome: WorkspaceStepOutcome): Effect.Effect<void> =>
    saveAndSendResult(step.workspaceId, step.key, outcome, () => {
      step.finished = true;
      releaseStep(step);
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
    holdWorkspaceLock(
      step.workspaceId,
      Effect.suspend(() => {
        step.phase = "running";
        return runAction(frame, action);
      }),
    ).pipe(
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

  /**
   * Answers for an agent step this runner knows, and returns whether it knew
   * the step. A known step is one that is:
   *
   * - settled: nothing is sent;
   * - recorded, with its turn still running: nothing is sent, because the
   *   turn's end sends the result;
   * - recorded, with its turn no longer running: the session ended while no
   *   connection was up, so its exit never reached the supervisor. The step
   *   is forgotten and answered with `interrupted`;
   * - finished, with a saved result: the result is sent again.
   *
   * Returns false, and sends nothing, for any other step.
   */
  const answerKnownAgentStep = (
    key: WorkspaceStepKey,
    workspaceId: string | null,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const name = buildStepName(key);
      if (settled.has(name)) return true;
      const recorded = agentSteps.get(name);
      if (recorded !== undefined) {
        if (yield* recorded.isTurnRunning) return true;
        // Unless the turn ended while `isTurnRunning` was read: its result
        // file then answers below.
        if (agentSteps.get(name) === recorded) {
          agentSteps.delete(name);
          yield* send(buildResultFrame(key, AGENT_TURN_UNKNOWN));
          return true;
        }
      }
      const saved = readStepResult(storageDir, workspaceId, key);
      if (saved === undefined) return false;
      yield* send(buildResultFrame(key, saved));
      return true;
    });

  /**
   * Answers the controller's question about an agent step, as `start`
   * describes. Takes no workspace lock and runs nothing.
   */
  const answerAgentStep = (frame: AgentStepResultRequest): Effect.Effect<void> =>
    Effect.gen(function* () {
      const key = readKey(frame);
      if (yield* answerKnownAgentStep(key, frame.workspaceId)) return;
      yield* send(buildResultFrame(key, AGENT_TURN_UNKNOWN));
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
        if (frame.kind === "agent") return yield* answerAgentStep(frame);
        const key = readKey(frame);
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
          agentSteps.delete(name);
          const step = held.get(name);
          // Detached, because stopping git can take the full grace period,
          // and the connection must go on handling frames meanwhile.
          if (step !== undefined) yield* Effect.forkDetach(stopStep(step));
        }
      }),

    listInFlight: () => [...held.values(), ...agentSteps.values()].map((step) => step.key),

    beginAgentStep: (key, workspaceId, isTurnRunning) =>
      Effect.sync(() => {
        const name = buildStepName(key);
        if (settled.has(name)) return false;
        agentSteps.set(name, { key: readKey(key), workspaceId, isTurnRunning });
        return true;
      }),

    finishAgentStep: (key, outcome) =>
      Effect.suspend(() => {
        const name = buildStepName(key);
        const step = agentSteps.get(name);
        if (step === undefined) return Effect.void;
        return saveAndSendResult(step.workspaceId, step.key, outcome, () => {
          agentSteps.delete(name);
        });
      }),

    forgetAgentStep: (key) => {
      agentSteps.delete(buildStepName(key));
    },

    runUnderWorkspaceLock: (workspaceId, maxWait, effect) =>
      Effect.suspend(() => {
        let began = false;
        const run = holdWorkspaceLock(
          workspaceId,
          Effect.suspend(() => {
            began = true;
            return Effect.asSome(effect);
          }),
        );
        // Gives up only while the lock is still awaited. Once `effect` has
        // begun, this never ends, so the race waits for `effect` instead of
        // interrupting it halfway.
        const giveUp = Effect.andThen(
          Effect.sleep(maxWait),
          Effect.suspend(() => (began ? Effect.never : Effect.succeedNone)),
        );
        return Effect.raceFirst(run, giveUp);
      }),
  };
};
