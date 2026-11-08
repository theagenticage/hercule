import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { formatIssue, Validation, type NotificationSubject } from "@hercule/contract";
import { absorbFailures } from "../../absorbing";
import { withTransaction } from "../../db";
import { formatInlineCode, Notifier } from "../../notifications";
import { TaskService } from "../../tasks";
import { WorkflowService, type ShippedWorkflowSource } from "../../workflows";

/** The kind of the notification raised for a shipped workflow that failed validation. */
const FAILED_KIND = "core.shipped-workflow-failed";

/** How many of a source's validation errors its notification lists. */
const LISTED_ERRORS = 3;

/** One shipped workflow whose source did not validate, with every error found. */
interface RejectedSource {
  readonly key: string;
  readonly errors: Validation["error"]["details"]["issues"];
}

/**
 * The reason a first install rolled back: at least one shipped source did not
 * validate. It never leaves `installShippedWorkflows`: the function turns it
 * into notifications.
 */
class SourcesRejected extends Data.TaggedError("SourcesRejected")<{
  readonly rejected: ReadonlyArray<RejectedSource>;
}> {}

/** Returns the subject a shipped workflow's notification is about. */
const buildSubject = (key: string): NotificationSubject => ({ kind: "shippedWorkflow", id: key });

/**
 * Returns the body of the notification raised when a shipped source does not
 * validate: what happened, what the user can do, and the first errors.
 *
 * Each error is shown as inline code, because the body is Markdown and an
 * error message can quote text that would otherwise turn into a link.
 */
const describeRejectedSource = (errors: RejectedSource["errors"]): string => {
  const listed = errors.slice(0, LISTED_ERRORS).map(formatIssue);
  const more = errors.length - listed.length;
  return [
    "This workflow ships with Hercule, and the controller could not install it, so no shipped workflow was installed. " +
      "The next start tries again. If it keeps failing, report this: the fault is in the workflow's source, not in anything you changed.",
    "",
    "What did not validate:",
    ...listed.map((line) => `- ${formatInlineCode(line)}`),
    ...(more > 0 ? [`- and ${String(more)} more`] : []),
  ].join("\n");
};

/**
 * Installs the shipped workflows in `sources` that were never installed, and
 * does nothing else when every key was installed before (a deleted or edited
 * shipped workflow keeps its key, so it is never installed again).
 *
 * The missing keys install together in one transaction: each workflow with
 * its triggers and its key, then, when one of them moves cards
 * (`movesCards`), the first-install reconciliation, which writes a
 * fact for every live Task's link to a thing that has a lifecycle.
 * The transaction commits only if every source validates and the
 * reconciliation succeeds. Then the Event Router, which reads the log after
 * the commit, finds the triggers in place. A boot that installs a key
 * withdraws the failure notification of that key.
 *
 * If any source does not validate, nothing is installed and the function
 * returns normally: the boot must go on. The core raises one
 * `core.shipped-workflow-failed` notification for each failing key, with the
 * reasons, unless one is still open for the key. The next boot tries again.
 *
 * Fails with `SqlError` when the database cannot be read or written. Nothing
 * from that attempt is stored.
 */
export const installShippedWorkflows = (
  sources: ReadonlyArray<ShippedWorkflowSource>,
): Effect.Effect<void, SqlError, WorkflowService | Notifier | TaskService | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workflows = yield* WorkflowService;
    const notifier = yield* Notifier;
    const tasks = yield* TaskService;

    const installedKeys = yield* workflows.listInstalledShippedKeys();
    const missing = sources.filter((shipped) => !installedKeys.has(shipped.key));
    if (missing.length === 0) return;

    const attempt = yield* Effect.result(
      withTransaction(
        sql,
        Effect.gen(function* () {
          const rejected: Array<RejectedSource> = [];
          for (const shipped of missing) {
            // A source that does not validate writes nothing, so the others
            // are still tried and every failing key is reported at once.
            const installed = yield* Effect.result(workflows.installShipped(shipped));
            if (Result.isSuccess(installed)) continue;
            if (!(installed.failure instanceof Validation))
              return yield* Effect.fail(installed.failure);
            rejected.push({ key: shipped.key, errors: installed.failure.error.details.issues });
          }
          // Failing here rolls back the sources that did install.
          if (rejected.length > 0) return yield* Effect.fail(new SourcesRejected({ rejected }));
          yield* notifier.withdrawDecisionsAbout(
            missing.map((shipped) => buildSubject(shipped.key)),
            "installed",
            FAILED_KIND,
          );
          // Cards whose pull request was linked before the workflows existed
          // get their first fact now, in the transaction that installs the
          // triggers. It runs only here, never on an ordinary start, and only
          // when a workflow that moves cards is installed: a fact written at
          // any other start would be newer than a drag's fence and would undo
          // the drag.
          if (missing.some((shipped) => shipped.movesCards === true)) {
            yield* tasks.recordFirstInstallFacts();
          }
        }),
      ),
    );
    if (Result.isSuccess(attempt)) return;
    if (!(attempt.failure instanceof SourcesRejected)) return yield* Effect.fail(attempt.failure);

    yield* Effect.forEach(
      attempt.failure.rejected,
      ({ key, errors }) =>
        notifier.createCoreNotification(
          {
            kind: FAILED_KIND,
            title: `The shipped workflow ${key} could not be installed`,
            body: describeRejectedSource(errors),
            subject: [buildSubject(key)],
            // The Dismiss answer makes this a decision, which stays open
            // until a boot installs the key and withdraws it. A notification
            // with no answer is born resolved and could not be withdrawn.
            actions: [{ id: "dismiss", label: "Dismiss", operation: null }],
          },
          { unlessOpenAbout: [buildSubject(key)] },
        ),
      { discard: true },
    );
  });

/**
 * Installs the shipped workflows as a step of the boot, and logs a failure
 * instead of returning it. The step runs after the plugins start, because a
 * source is validated against the actions and event kinds of the active
 * plugins, and before ingest starts. A failure must not keep the controller
 * from starting: nothing was stored, and the next boot tries again.
 */
export const installShippedWorkflowsOrLog = (
  sources: ReadonlyArray<ShippedWorkflowSource>,
): Effect.Effect<void, never, WorkflowService | Notifier | TaskService | SqlClient.SqlClient> =>
  absorbFailures(
    "The shipped workflows could not be installed; the next start tries again",
    installShippedWorkflows(sources),
  );
