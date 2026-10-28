/**
 * Keeps the invalid mark of the stored workflows up to date.
 *
 * A stored workflow validated when it was saved, but it can stop validating
 * without being edited: the plugin whose action it calls is disabled, the
 * agent or Connection it names is deleted, or a newer controller checks it
 * more strictly than the one that saved it. So after such a change the
 * controller validates every stored workflow again, with the same checks a
 * save runs, and marks the workflows that fail as invalid. While a workflow
 * is invalid its start triggers are not routed, and a manual run is refused
 * because `run.start` validates the workflow again.
 *
 * The plugins, agents and connections domains cannot import this domain,
 * because this domain depends on all three. So each declares a port that
 * reports its change, and the controller daemon implements every port with
 * `revalidateStoredWorkflows`. Boot also calls it once after the plugins
 * start, because the mark is stored, and the plugins or the controller may
 * have changed while the controller was stopped.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { decodeWorkflowDefinition, formatIssue, type Issue } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog, type EventKinds } from "../events";
import { formatInlineCode, Notifier } from "../notifications";
import type { PluginHost } from "../plugins";
import { listReferencedIds, workflowReferences } from "./references";
import { workflowRepository, type StoredDefinition } from "./repository";
import { validateDefinition } from "./validation";

/** How many of a workflow's validation errors its notification lists. */
const LISTED_ERRORS = 3;

/**
 * The error a stored workflow gets when the controller fails while it
 * validates the stored definition, rather than finding errors in it. The
 * definition decoded first, so the cause is a fault in the controller.
 * Saving the workflow again stores its definition anew.
 */
const UNCHECKABLE_DEFINITION: Issue = {
  path: [],
  message:
    "The controller failed while it validated the stored definition, and logged why. " +
    "Save the workflow again to store its definition anew.",
};

/**
 * Returns the body of the notification raised when a stored workflow stops
 * validating: why it can happen, what stopped, what to do, and the first
 * errors with their paths.
 *
 * Each error is shown as inline code. An error message can quote what the
 * author wrote, and the body is Markdown, so quoted text shown as is could
 * add a link or an image to the notification.
 */
export const describeInvalidWorkflow = (errors: ReadonlyArray<Issue>): string => {
  const listed = errors.slice(0, LISTED_ERRORS).map(formatIssue);
  const more = errors.length - listed.length;
  return [
    "This workflow no longer validates: a plugin, agent or Connection it uses has changed, " +
      "or this version of the controller checks the workflow more strictly than the one that saved it. " +
      "Until it validates again, its triggers start no runs and `run.start` refuses it: " +
      "fix the workflow and save it, or undo the change.",
    "",
    "What did not validate:",
    ...listed.map((line) => `- ${formatInlineCode(line)}`),
    ...(more > 0 ? [`- and ${String(more)} more`] : []),
  ].join("\n");
};

/**
 * Runs `effect`, and logs its failure with `message` instead of passing it
 * on, so one workflow cannot stop the pass over the others. An interrupt is
 * passed on, because it means the pass itself is being stopped.
 */
const logFailure = <E>(message: string, effect: Effect.Effect<void, E>): Effect.Effect<void, E> =>
  Effect.catchCause(effect, (cause) =>
    Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.logError(message, cause),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workflows = yield* workflowRepository;
  const audit = yield* AuditLog;
  const notifier = yield* Notifier;
  const { readSharedReferences } = yield* workflowReferences;
  // One pass at a time. Two passes that overlapped could each read the state
  // before the other's change, and the older one could write last.
  const passes = yield* Semaphore.make(1);

  /**
   * Writes the new mark of one workflow, with its audit entry and, when the
   * workflow became invalid, its notification, in one transaction. Writes
   * nothing when the workflow was saved, or its mark changed, since it was
   * read.
   */
  const writeMark = (
    workflow: StoredDefinition,
    errors: ReadonlyArray<Issue>,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const isInvalid = errors.length > 0;
        const wrote = yield* workflows.setInvalidSince(workflow, isInvalid ? at : undefined);
        if (!wrote) return;
        yield* audit.append({
          kind: isInvalid ? "workflow.invalidated" : "workflow.revalidated",
          actor: SYSTEM_ACTOR,
          record: { topic: "workflow", id: workflow.id },
          payload: { workflowId: workflow.id },
          at,
        });
        if (!isInvalid) return;
        yield* notifier.createCoreNotification({
          kind: "core.workflow-invalid",
          title: `The workflow ${workflow.name} no longer validates`,
          body: describeInvalidWorkflow(errors),
          subject: [{ kind: "workflow", id: workflow.id }],
        });
      }),
    );

  return {
    /**
     * Validates every stored workflow again, with the checks a save runs, and
     * updates each workflow's invalid mark:
     *
     * - a valid workflow that fails is marked invalid from now, writes a
     *   `workflow.invalidated` audit entry and raises one
     *   `core.workflow-invalid` notification;
     * - an invalid workflow that passes loses its mark and writes a
     *   `workflow.revalidated` audit entry;
     * - any other workflow is left as it is, so a workflow that stays
     *   invalid raises no second notification.
     *
     * The references are read once for all the workflows, and the workflows
     * are validated outside any transaction. Each changed mark is then
     * written in a transaction of its own, and skipped if a save changed the
     * workflow in between: the save validated the new source and set the
     * mark itself.
     *
     * A stored definition that no longer decodes, because an older
     * controller stored it under looser rules, is invalid, and its schema
     * errors are its errors. A workflow whose validation fails, rather than
     * finding errors, is marked invalid with an error that says so, and the
     * cause is logged.
     * A failed write is logged too. Neither stops the other workflows.
     *
     * The system makes these changes, so every entry has the system actor.
     * Each entry names the workflow, so clients that watch the `workflow`
     * topic read it again. Fails with `SqlError` only when the workflows or
     * their references cannot be read.
     */
    revalidateStoredWorkflows: (): Effect.Effect<void, SqlError> =>
      passes.withPermits(1)(
        Effect.gen(function* () {
          const stored = yield* workflows.listStoredDefinitions();
          // A definition stored by an older controller may not match the
          // current schema, such as a spawn bound over today's limits, so
          // each is decoded as a save decodes it, and its schema errors are
          // its errors.
          const decoded = stored.map((workflow) => decodeWorkflowDefinition(workflow.definition));
          const references = yield* readSharedReferences(
            decoded.flatMap((result) =>
              Result.isSuccess(result) ? [listReferencedIds(result.success)] : [],
            ),
          );
          const at = yield* nowIso;
          for (const [index, workflow] of stored.entries()) {
            const definition = decoded[index]!;
            const checked: Exit.Exit<ReadonlyArray<Issue>> = Result.isSuccess(definition)
              ? yield* Effect.exit(
                  Effect.map(
                    validateDefinition(definition.success, references),
                    (issues) => issues.errors,
                  ),
                )
              : Exit.succeed(definition.failure);
            if (Exit.isFailure(checked)) {
              if (Cause.hasInterrupts(checked.cause)) return yield* Effect.failCause(checked.cause);
              yield* Effect.logError(
                `The stored workflow ${workflow.id} could not be validated`,
                checked.cause,
              );
            }
            const errors = Exit.isSuccess(checked) ? checked.value : [UNCHECKABLE_DEFINITION];
            if (errors.length > 0 === (workflow.invalidSince !== undefined)) continue;
            yield* logFailure(
              `The invalid mark of the stored workflow ${workflow.id} could not be written`,
              writeMark(workflow, errors, at),
            );
          }
        }),
      ),
  };
});

/**
 * The service that validates the stored workflows again and keeps their
 * invalid mark up to date. The controller daemon calls it after a change to
 * a plugin, Agent or Connection, and once at boot.
 */
export class WorkflowValidity extends Context.Service<
  WorkflowValidity,
  Effect.Success<typeof make>
>()("hercule/controller/workflows/WorkflowValidity") {}

export const WorkflowValidityLayer: Layer.Layer<
  WorkflowValidity,
  never,
  SqlClient.SqlClient | AuditLog | Notifier | PluginHost | EventKinds
> = Layer.effect(WorkflowValidity)(make);
