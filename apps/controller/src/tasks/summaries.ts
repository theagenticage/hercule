/**
 * Writing Task Summaries: the rules that decide which Tasks get a summary,
 * how often, and what happens to an answer that arrives late.
 *
 * `TaskService.markSummaryDirty` records that a Task changed. This module does
 * the other half. `TaskSummaries.writeDue` claims the Tasks that are due, asks
 * a describer (supplied by the caller, because the model call belongs to the
 * controller daemon) for the three texts of each, and stores the answer or the
 * failure. Everything between the claim and the store is guarded by the row's
 * revision, so a Task that changed, ended or was merged away while the model
 * worked cannot get a wrong write.
 *
 * Nothing in memory matters across a restart. The `task_summaries` rows hold
 * what is dirty and when each Task may be tried again.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { TaskSummary } from "@hercule/contract";
import { absorbFailures } from "../absorbing";
import { SYSTEM_ACTOR } from "../actor";
import { addSeconds, announceTaskCardChange, nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PromotionState } from "../promotion";
import { cutText } from "../text";
import { taskRepository, type SummaryAttempt } from "./repository";

/**
 * How long after the first change since its last summary a Task waits before
 * its summary is written, in seconds. A burst of changes then makes one
 * summary. Later changes do not extend the wait: a busy Task is paced by
 * `SUMMARY_MIN_INTERVAL_SECONDS` instead.
 */
export const SUMMARY_QUIET_SECONDS = 30;

/**
 * The fewest seconds between two attempts to write one Task's summary,
 * failed attempts included. A failure waits longer each time it repeats.
 */
export const SUMMARY_MIN_INTERVAL_SECONDS = 300;

/** The most seconds a Task waits after repeated failures: one hour. */
const SUMMARY_MAX_BACKOFF_SECONDS = 3600;

/** The most characters of a failure reason that are stored. */
const MAX_SUMMARY_FAILURE_REASON = 500;

/**
 * How many summaries are written at once. A burst of changed Tasks must not
 * fill the ten text generation slots of a runner, which Thread titles need
 * too, so a backlog drains this many at a time.
 */
export const SUMMARY_CONCURRENCY = 2;

/** The three texts of a summary, checked against the contract's bounds before they are stored. */
const SummaryText = Schema.Struct({
  line: TaskSummary.fields.line,
  standing: TaskSummary.fields.standing,
  left: TaskSummary.fields.left,
});

export type SummaryText = Schema.Schema.Type<typeof SummaryText>;

const decodeSummaryText = Schema.decodeUnknownEffect(SummaryText);

/** What `TaskSummaries.writeDue` needs from the caller: the model, behind two questions. */
export interface SummaryDescriber {
  /**
   * Returns whether a summary can be written now. It is asked only when a Task
   * is due, and before any Task is claimed, so a Task is never marked as tried
   * when no call could be made. While it returns false the Tasks stay due.
   */
  readonly canDescribe: Effect.Effect<boolean, SqlError>;
  /**
   * Returns the three texts of the summary of the Task `taskId`, or fails with
   * the reason it could not. The texts must fit the contract's bounds
   * (`MAX_SUMMARY_LINE` and the other two): an overlong text is a defect.
   * It runs outside any transaction and may take as long as the model needs.
   */
  readonly describe: (taskId: string) => Effect.Effect<SummaryText, string>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* taskRepository;
  const audit = yield* AuditLog;
  const promotion = yield* PromotionState;

  /**
   * Picks the Tasks whose summary is due, oldest change first, at most
   * `limit` of them, and records an attempt on each, in one short
   * transaction. A Task is due when it is live (not deleted, merged or
   * finished), first changed at least `SUMMARY_QUIET_SECONDS` ago, and is past
   * its `next_attempt_at`. Each pick sets `next_attempt_at` to
   * `SUMMARY_MIN_INTERVAL_SECONDS` from now, so a Task is called for at most
   * once in that time, failures included.
   */
  const claimDue = (limit: number): Effect.Effect<ReadonlyArray<SummaryAttempt>, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        return yield* tasks.claimSummaryAttempts({
          limit,
          at,
          quietBefore: addSeconds(at, -SUMMARY_QUIET_SECONDS),
          nextAttemptAt: addSeconds(at, SUMMARY_MIN_INTERVAL_SECONDS),
        });
      }),
    );

  /**
   * Stores the summary made for the revision of `attempt`, in one short
   * transaction. Stores nothing when the Task is no longer live (deleted,
   * merged or finished), or when the row already holds a summary made from a
   * newer revision. Never makes a row.
   *
   * - When the Task has not changed since the claim, the summary is current:
   *   the row is clean.
   * - When it changed meanwhile, the summary is stored all the same and the
   *   row stays dirty, so the card shows it as stale and the next attempt,
   *   paced by `next_attempt_at`, brings it up to date. A Task that changes
   *   during every call would otherwise never get a summary.
   *
   * A stored summary clears the failure and resets the failure count. It
   * writes a `task.summarized` audit entry stamped with the system actor and
   * announces the Task as a derived change. It does not touch the Task's
   * `updatedAt`, writes no `task.updated` event, and marks nothing dirty.
   */
  const store = (attempt: SummaryAttempt, summary: SummaryText): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const checked = yield* Effect.orDie(decodeSummaryText(summary));
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const written = yield* tasks.writeSummary({
            taskId: attempt.taskId,
            dirtyRevision: attempt.dirtyRevision,
            summary: checked,
            at,
          });
          if (!written) return;
          // Only ids go in the entry: the text of a summary is not kept in the log.
          yield* audit.append({
            kind: "task.summarized",
            actor: SYSTEM_ACTOR,
            payload: { taskId: attempt.taskId, dirtyRevision: attempt.dirtyRevision },
            at,
          });
          yield* announceTaskCardChange(attempt.taskId);
        }),
      );
    });

  /**
   * Records that the attempt failed, in one short transaction. Keeps the last
   * summary, stores the (cut) `reason` with the time, raises the failure
   * count, and sets `next_attempt_at` to now plus `SUMMARY_MIN_INTERVAL_SECONDS`
   * doubled for each failure in a row, at most one hour. The row stays dirty,
   * so the card shows the summary as stale. Unlike `store`, it records nothing
   * when the Task changed since: a failure of an older attempt says nothing
   * about the Task now. It also records nothing when the Task is no longer
   * live, so a late failure cannot touch a Task that was merged away.
   */
  const fail = (attempt: SummaryAttempt, reason: string): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* tasks.writeSummaryFailure({
          taskId: attempt.taskId,
          dirtyRevision: attempt.dirtyRevision,
          reason: cutText(reason, MAX_SUMMARY_FAILURE_REASON),
          at,
          chooseNextAttempt: (attemptCount) =>
            addSeconds(
              at,
              Math.min(
                SUMMARY_MIN_INTERVAL_SECONDS * 2 ** attemptCount,
                SUMMARY_MAX_BACKOFF_SECONDS,
              ),
            ),
        });
      }),
    );

  /**
   * Writes the summary of one claimed Task, or records why it failed. The
   * describer runs outside any transaction. Each database write waits for the
   * controller to be serving (`PromotionState`), as every background write
   * does, and the model call is not counted as work a promotion waits for.
   *
   * One Task's trouble, a failure or a defect, is logged and must not stop the
   * Task beside it. An interrupt is passed on.
   */
  const writeOne = (attempt: SummaryAttempt, describer: SummaryDescriber) =>
    absorbFailures(
      `Writing the summary of Task ${attempt.taskId} failed`,
      Effect.gen(function* () {
        const outcome = yield* Effect.result(describer.describe(attempt.taskId));
        yield* promotion.whenServing(
          Result.isSuccess(outcome)
            ? store(attempt, outcome.success)
            : fail(attempt, outcome.failure),
        );
      }),
    );

  return {
    /**
     * Writes the summaries that are due, `SUMMARY_CONCURRENCY` Tasks at a time,
     * until none is due. Returns when the next Task becomes due, or none when
     * no live Task is dirty. Checks no grant.
     *
     * The time is not in the future when the method stops with Tasks still
     * due: `describer.canDescribe` was false, or a Task due a moment ago was
     * claimed by someone else. The caller then sleeps instead of calling
     * again at once.
     *
     * A look is one read of the earliest due time, on the read connection.
     * Only when a Task is due does it ask `canDescribe` and claim, so a Task
     * that is 30 seconds from due costs one read and no write.
     *
     * Fails only when the database cannot be read or written. A failure to
     * describe one Task is recorded on that Task, and a defect while writing
     * one Task is logged, without stopping the others.
     */
    writeDue: (describer: SummaryDescriber): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.gen(function* () {
        while (true) {
          const dueAt = yield* tasks.readNextSummaryDueAt(SUMMARY_QUIET_SECONDS);
          if (Option.isNone(dueAt)) return dueAt;
          if (Date.parse(dueAt.value) > (yield* Clock.currentTimeMillis)) return dueAt;
          if (!(yield* describer.canDescribe)) return dueAt;
          const attempts = yield* promotion.whenServing(claimDue(SUMMARY_CONCURRENCY));
          if (attempts.length === 0) return dueAt;
          yield* Effect.forEach(attempts, (attempt) => writeOne(attempt, describer), {
            concurrency: SUMMARY_CONCURRENCY,
            discard: true,
          });
        }
      }),
  };
});

/** Writes the Task Summaries that are due. */
export class TaskSummaries extends Context.Service<TaskSummaries, Effect.Success<typeof make>>()(
  "hercule/controller/tasks/TaskSummaries",
) {}

export const TaskSummariesLayer: Layer.Layer<
  TaskSummaries,
  never,
  SqlClient.SqlClient | AuditLog | PromotionState
> = Layer.effect(TaskSummaries)(make);
