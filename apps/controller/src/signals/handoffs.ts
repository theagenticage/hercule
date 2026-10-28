/**
 * The handoff of a signal to a workflow: the execution of `signal.handOff`,
 * the operation a signal's Hand to an agent answers bind. It starts a
 * workflow on a signal and puts the work on a Task (spec 11, `signal`;
 * ADR 0046).
 *
 * It is a service of its own, not a `SignalService` method, because
 * `SignalService.act` runs an answer's operation through the
 * `BoundOperations` port, and the controller daemon's port calls this
 * service for `signal.handOff`. A `SignalService` method would make
 * `SignalService` call `BoundOperations`, which would call `SignalService`.
 *
 * The Task lookup is exported because the describe line of the answer needs
 * the same lookup to say which Task the handoff would continue.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  ExternalRef,
  HAND_TO_ACTION_PREFIX,
  type InvalidState,
  type NotFound,
  type RunStarted,
  type Signal,
  type SignalHandOffCall,
  type SignalOrigin,
  type Task,
} from "@hercule/contract";
import { requireUserActor } from "../actor";
import type { BoundOperationError } from "../bound-actions";
import { mintUuid, uuidToString } from "../db";
import { RunService } from "../runs";
import { TaskService, taskRepository } from "../tasks";
import { workflowRepository } from "../workflows";
import { findSignalInput } from "./actions";
import { signalRepository } from "./repository";

/** The refusal of a handoff for a caller who is not the user. */
export const ONLY_THE_USER_HANDS_OFF =
  "only the user may hand a signal off: it starts a workflow as the user and takes the signal off the list, so a session or a workflow step may not; ask the user instead";

/** The refusal of an action on a signal that is already resolved. */
export const ALREADY_RESOLVED =
  "the signal is already resolved, so its actions can no longer be taken";

/**
 * Checks that `signal` can be handed to the workflow: it is open, and it
 * offers a Hand to an agent action for that workflow. Fails with
 * `InvalidState` when the signal is resolved, and with `NotFound` when it
 * offers no action for the workflow, saying which workflows it does offer.
 */
export const checkOffersHandoff = (
  signal: Signal,
  workflowId: string,
): Effect.Effect<void, InvalidState | NotFound> => {
  if (signal.status !== "open") return Effect.fail(createInvalidStateError(ALREADY_RESOLVED));
  const actionId = `${HAND_TO_ACTION_PREFIX}${workflowId}`;
  if (signal.actions.some((candidate) => candidate.id === actionId)) return Effect.void;
  const offered = signal.actions
    .filter((candidate) => candidate.id.startsWith(HAND_TO_ACTION_PREFIX))
    .map((candidate) => candidate.id.slice(HAND_TO_ACTION_PREFIX.length));
  return Effect.fail(
    createNotFoundError(
      offered.length === 0
        ? `the signal is not offered to the workflow ${workflowId}; it cannot be handed to any workflow`
        : `the signal is not offered to the workflow ${workflowId}; it can be handed to the workflows ${offered.join(", ")}`,
    ),
  );
};

type TaskRepository = Effect.Success<typeof taskRepository>;

const isExternalRef = Schema.is(ExternalRef);

/**
 * Returns the External Ref of the thread a signal is about, or none. Only a
 * plugin's signal has a thread, and only a thread ref that is an External Ref
 * (`<system>:<kind>:<identity>`) can be found in a Task's provenance, so a
 * core signal, or a thread ref in another form, has none.
 */
export const readThreadRef = (origin: SignalOrigin): Option.Option<ExternalRef> =>
  origin.type === "event" && isExternalRef(origin.threadRef)
    ? Option.some(origin.threadRef)
    : Option.none();

/**
 * Returns the open Task (status `open` or `in-progress`) whose provenance
 * carries `ref`, or none. When several do, it returns the one updated most
 * recently. A deleted Task is never returned.
 *
 * It takes the task repository, not `TaskService`, because the describe line
 * runs this same lookup and reads rows directly (see the describer's module
 * comment). Sharing one lookup means the describe line names the Task the
 * handoff then continues.
 */
export const findTaskToContinue = (
  tasks: TaskRepository,
  ref: ExternalRef,
): Effect.Effect<Option.Option<Task>, SqlError> =>
  tasks
    .list(
      { refs: [ref], status: ["open", "in-progress"] },
      {
        limit: 1,
        cursor: undefined,
        order: { _tag: "column", sort: [{ field: "updatedAt", direction: "desc" }] },
      },
    )
    .pipe(
      // No cursor is given, so the listing has none to refuse.
      Effect.catchTag("CursorError", (error) => Effect.die(error)),
      Effect.map((page) => Option.fromNullishOr(page.items[0])),
    );

const make = Effect.gen(function* () {
  const signals = yield* signalRepository;
  const workflows = yield* workflowRepository;
  const taskRows = yield* taskRepository;
  const tasks = yield* TaskService;
  const runs = yield* RunService;

  return {
    /**
     * Hands a signal to a workflow, and returns the started run. It runs in
     * the caller's transaction, the one that resolves the signal, and in
     * order:
     *
     * 1. checks the caller is the user, the signal is open, and the signal
     *    offers a Hand to an agent answer for the workflow that binds
     *    `signal.handOff` on this signal (see `checkOffersHandoff`). Every
     *    caller is checked, so a caller inside the controller cannot skip it;
     * 2. reads the workflow, and finds its input for signals of the signal's
     *    kind;
     * 3. finds the Task to continue by the signal's thread ref (see
     *    `findTaskToContinue`), or decides the id of a new Task;
     * 4. starts the run linked to that Task, with the signal as the
     *    workflow's signal input. Placing the run's first session waits until
     *    the transaction commits;
     * 5. records the handoff on the Task with `TaskService.recordHandoff`:
     *    a continued Task is set `in-progress` and gets the entry, and a new
     *    Task is created `in-progress` with the signal's title and priority
     *    and the entry. Either way it is one write, so one `task.created` or
     *    `task.updated` event carries the entry. The entry names the signal
     *    and the run, with the thread ref and the signal's event when it has
     *    them.
     *
     * Fails with `Forbidden` for any caller but the user, `NotFound` when the
     * signal or the workflow does not exist or the signal does not offer the
     * workflow, `InvalidState` when the signal is resolved, `Validation` when
     * the answer names another signal or the workflow takes no signal of the
     * signal's kind, and with whatever starting the run fails with, such as a
     * workflow that is invalid or has no capable runner. The caller's
     * transaction then rolls back.
     *
     * The run is started before the Task is written, so a new Task has the id
     * chosen in step 3: the run names the Task, and the Task's first entry
     * names the run.
     */
    handOff: (input: SignalHandOffCall): Effect.Effect<RunStarted, BoundOperationError> =>
      Effect.gen(function* () {
        yield* requireUserActor("signal.handOff", ONLY_THE_USER_HANDS_OFF);
        const signal = Option.getOrUndefined(yield* signals.read(input.signalId));
        if (signal === undefined) return yield* Effect.fail(createNotFoundError("no such signal"));
        yield* checkOffersHandoff(signal, input.workflowId);
        const offered = signal.actions.find(
          (candidate) => candidate.id === `${HAND_TO_ACTION_PREFIX}${input.workflowId}`,
        )?.operation;
        if (
          offered?.op !== "signal.handOff" ||
          (offered.input as { readonly signalId?: unknown }).signalId !== signal.id
        ) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["workflowId"],
                message: `The signal's answer for the workflow ${input.workflowId} does not hand this signal off. Take another action.`,
              },
            ]),
          );
        }
        const definition = Option.getOrUndefined(yield* workflows.readDefinition(input.workflowId));
        if (definition === undefined) {
          return yield* Effect.fail(createNotFoundError("no such workflow"));
        }
        const signalInput = findSignalInput(definition, signal.kind);
        if (signalInput === undefined) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["workflowId"],
                message: `The workflow ${definition.name} has no input that takes a signal of kind ${signal.kind}. Hand the signal to a workflow that has one.`,
              },
            ]),
          );
        }

        const ref = readThreadRef(signal.origin);
        const existing = Option.isSome(ref)
          ? Option.getOrUndefined(yield* findTaskToContinue(taskRows, ref.value))
          : undefined;
        const taskId = existing?.id ?? uuidToString(mintUuid());

        const started = yield* runs.startOnTask(
          { workflowId: input.workflowId, inputs: { [signalInput.name]: input.signalId } },
          taskId,
        );

        yield* tasks.recordHandoff({
          taskId,
          entry: {
            signalId: input.signalId,
            runId: started.runId,
            ...(Option.isSome(ref) ? { ref: ref.value } : {}),
            ...(signal.origin.type === "event" ? { eventId: signal.origin.eventId } : {}),
          },
          ...(existing === undefined
            ? { newTask: { title: signal.title, priority: signal.priority } }
            : {}),
        });
        return started;
      }),
  };
});

/** The handoff service. */
export class SignalHandoffs extends Context.Service<SignalHandoffs, Effect.Success<typeof make>>()(
  "hercule/controller/signals/SignalHandoffs",
) {}

export const SignalHandoffsLayer: Layer.Layer<
  SignalHandoffs,
  never,
  SqlClient.SqlClient | TaskService | RunService
> = Layer.effect(SignalHandoffs)(make);
