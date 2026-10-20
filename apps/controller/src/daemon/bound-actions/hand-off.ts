/**
 * The execution of `signal.handOff`, the operation a signal's Hand to an
 * agent answers bind: it starts a workflow on a signal and puts the work on a
 * Task (spec 11, `signal`; ADR 0046).
 *
 * It lives in the controller daemon's bound actions, which run the operation
 * of every bound answer. `SignalService.act` runs an answer's operation
 * through the `BoundOperations` port, so the handoff cannot be a
 * `SignalService` method: `SignalService` would call `BoundOperations`, which
 * would call `SignalService`, a cycle between layers. The Task lookup is
 * exported because the describe line of the answer needs the same lookup to
 * say which Task the handoff would continue.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import type { BoundOperationError } from "../../bound-actions";
import { RunService } from "../../runs";
import { findSignalInput, signalRepository } from "../../signals";
import { TaskService, taskRepository } from "../../tasks";
import { workflowRepository } from "../../workflows";

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
 * It reads the repository, not `TaskService.query`, because both callers must
 * skip the grant check: the handoff runs inside the user's `signal.act`, whose
 * grant was already checked, and the describer reads rows directly for any
 * describe line.
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

/**
 * Builds the `signal.handOff` operation. It runs in the transaction that
 * resolves the signal, and in order:
 *
 * 1. reads the signal and the workflow, and finds the workflow's input for
 *    signals of the signal's kind;
 * 2. finds the Task to continue by the signal's thread ref (see
 *    `findTaskToContinue`), or creates a Task with the signal's title and
 *    priority;
 * 3. starts the run linked to the Task, with the signal as the workflow's
 *    signal input. Placing the run's first session waits until the
 *    transaction commits;
 * 4. sets the Task `in-progress` when it was not, and appends the provenance
 *    entry that names the signal and the run, with the thread ref and the
 *    signal's event when it has them.
 *
 * Returns the started run. Fails with `NotFound` when the signal or the
 * workflow does not exist, with `Validation` when the workflow takes no signal
 * of the signal's kind, and with whatever creating the Task or starting the
 * run fails with, such as a workflow that is invalid or has no capable
 * runner. The caller's transaction then rolls back, so no Task is left behind.
 */
export const makeHandOff = Effect.gen(function* () {
  const signals = yield* signalRepository;
  const workflows = yield* workflowRepository;
  const taskRows = yield* taskRepository;
  const tasks = yield* TaskService;
  const runs = yield* RunService;

  return (input: SignalHandOffCall): Effect.Effect<RunStarted, BoundOperationError> =>
    Effect.gen(function* () {
      const signal = Option.getOrUndefined(yield* signals.readForHandOff(input.signalId));
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
        ? yield* findTaskToContinue(taskRows, ref.value)
        : Option.none<Task>();
      const task = Option.isSome(existing)
        ? existing.value
        : yield* tasks.create({
            title: signal.title,
            description: "",
            priority: signal.priority,
          });

      const started = yield* runs.startOnTask(
        { workflowId: input.workflowId, inputs: { [signalInput.name]: input.signalId } },
        task.id,
      );

      yield* tasks.update({
        id: task.id,
        ...(task.status === "in-progress" ? {} : { status: "in-progress" as const }),
        provenance: [
          {
            signalId: input.signalId,
            runId: started.runId,
            ...(Option.isSome(ref) ? { ref: ref.value } : {}),
            ...(signal.origin.type === "event" ? { eventId: signal.origin.eventId } : {}),
          },
        ],
      });
      return started;
    });
});
