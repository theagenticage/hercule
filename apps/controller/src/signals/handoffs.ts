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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createNotFoundError,
  createValidationError,
  ExternalRef,
  type RunStarted,
  type SignalHandOffCall,
  type SignalOrigin,
  type Task,
} from "@hercule/contract";
import type { BoundOperationError } from "../bound-actions";
import { mintUuid, uuidToString } from "../db";
import { RunService } from "../runs";
import { TaskService, taskRepository } from "../tasks";
import { workflowRepository } from "../workflows";
import { findSignalInput } from "./actions";
import { signalRepository } from "./repository";

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
     * Hands a signal to a workflow. It runs in the caller's transaction, the
     * one that resolves the signal, and in order:
     *
     * 1. reads the signal and the workflow, and finds the workflow's input for
     *    signals of the signal's kind;
     * 2. finds the Task to continue by the signal's thread ref (see
     *    `findTaskToContinue`), or decides the id of a new Task;
     * 3. starts the run linked to that Task, with the signal as the
     *    workflow's signal input. Placing the run's first session waits until
     *    the transaction commits;
     * 4. writes the Task: a continued Task is set `in-progress` when it was
     *    not, and gets the handoff entry; a new Task is created `in-progress`
     *    with the signal's title and priority and the handoff entry. Either
     *    way it is one write, so one `task.created` or `task.updated` event
     *    carries the entry. The entry names the signal and the run, with the
     *    thread ref and the signal's event when it has them.
     *
     * Returns the started run. Fails with `NotFound` when the signal or the
     * workflow does not exist, with `Validation` when the workflow takes no
     * signal of the signal's kind, and with whatever starting the run fails
     * with, such as a workflow that is invalid or has no capable runner. The
     * caller's transaction then rolls back.
     *
     * The run is started before the Task is written, so a new Task has the id
     * chosen in step 2: the run names the Task, and the Task's first entry
     * names the run.
     */
    handOff: (input: SignalHandOffCall): Effect.Effect<RunStarted, BoundOperationError> =>
      Effect.gen(function* () {
        const signal = Option.getOrUndefined(yield* signals.readSummary(input.signalId));
        if (signal === undefined) return yield* Effect.fail(createNotFoundError("no such signal"));
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

        const entry = {
          signalId: input.signalId,
          runId: started.runId,
          ...(Option.isSome(ref) ? { ref: ref.value } : {}),
          ...(signal.origin.type === "event" ? { eventId: signal.origin.eventId } : {}),
        };
        if (existing === undefined) {
          yield* tasks.create({
            id: taskId,
            title: signal.title,
            description: "",
            priority: signal.priority,
            status: "in-progress",
            provenance: [entry],
          });
        } else {
          yield* tasks.update({
            id: taskId,
            ...(existing.status === "in-progress" ? {} : { status: "in-progress" as const }),
            provenance: [entry],
          });
        }
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
