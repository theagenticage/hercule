/**
 * The summary writer: the loop that keeps the Task Summaries current.
 *
 * The tasks domain keeps the bookkeeping in `task_summaries`: which Tasks
 * changed, since when, and when each may next be tried. This loop does the
 * part a domain cannot do, because it runs for the life of the controller and
 * waits on a model: it asks for the Tasks that are due, makes one Text
 * Generation per Task, and hands the answer back.
 *
 * Nothing in memory matters across a restart. The rows hold what is dirty and
 * when each Task may be tried again, so a new loop picks up where the last one
 * stopped. A call that a restart cut off is made again once the Task's
 * `next_attempt_at` has passed.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as SqlClient from "effect/sql/SqlClient";
import { PromotionState } from "../../promotion";
import {
  TaskService,
  TaskSummaryWake,
  type SummaryAttempt,
  type TaskTrackingRuns,
} from "../../tasks";
import {
  buildTextGenerationUnavailableReason,
  TextGeneration,
  TextGenerationModels,
} from "../../text-generation";
import { absorbFailures } from "../absorbing";
import { buildTaskSummaryCall, parseSummaryAnswer } from "./summary-input";

/**
 * How many summaries are written at once. A burst of changed Tasks must not
 * fill the ten text generation slots of a runner, which Thread titles need
 * too, so a backlog drains this many at a time.
 */
export const SUMMARY_CONCURRENCY = 2;

/**
 * The longest the loop sleeps without a wake. It sleeps until the first Task
 * is due, which can be an hour away after failures. A wake lost to a crash, or
 * a Text Generation Model that was Off, costs this delay at most.
 */
const SUMMARY_BACKSTOP = Duration.minutes(1);

/**
 * Writes the summary of one claimed attempt, or records why it failed.
 *
 * The model call runs outside any transaction. `storeSummary` and
 * `failSummary` are guarded by the revision the attempt was claimed at. An
 * answer for a Task that changed meanwhile is stored all the same and leaves
 * the Task dirty, and its `next_attempt_at` paces the next call. An answer for
 * a Task that ended meanwhile is dropped without a word, and so is a failure
 * of an older revision. Fails only when the database cannot be read or
 * written.
 */
const writeSummary = (attempt: SummaryAttempt) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const generation = yield* TextGeneration;
    const promotion = yield* PromotionState;
    const call = yield* buildTaskSummaryCall(attempt.taskId);
    if (Option.isNone(call)) return;

    const outcome = yield* Effect.result(
      generation.generate(call.value).pipe(
        Effect.mapError((error) => `${error.reason}: ${error.message}`),
        Effect.flatMap((answer) =>
          Effect.try({
            try: () => parseSummaryAnswer(answer),
            catch: () => "the model's answer did not hold the three texts of a summary",
          }),
        ),
      ),
    );
    yield* promotion.whenServing(
      Result.isSuccess(outcome)
        ? tasks.storeSummary({ ...attempt, summary: outcome.success })
        : tasks.failSummary({ ...attempt, reason: outcome.failure }),
    );
  });

/**
 * Writes the summaries that are due, a round of at most `SUMMARY_CONCURRENCY`
 * Tasks at a time, until none is due. Returns how long to sleep before the
 * next look: until the first Task becomes due, but at most `SUMMARY_BACKSTOP`.
 *
 * A look is one read of the earliest due time (see
 * `TaskService.readNextSummaryDueAt`). Only when a Task is due does it resolve
 * the Text Generation Model and claim, so a mark that is 30 seconds from due
 * costs one read and no write.
 *
 * The check for a model that is Off, or that no runner can run now, uses the
 * same reason `controller.read` reports. It comes before the claim, so a Task
 * is never marked as tried when no call could be made. Then the Tasks stay
 * due, and the sleep is the backstop: the next wake, such as the one after the
 * setting changes, finds them still there.
 */
const writeDueSummaries = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const models = yield* TextGenerationModels;
  const promotion = yield* PromotionState;
  while (true) {
    const dueAt = yield* tasks.readNextSummaryDueAt();
    if (Option.isNone(dueAt)) return SUMMARY_BACKSTOP;
    const untilDue = Date.parse(dueAt.value) - (yield* Clock.currentTimeMillis);
    if (untilDue > 0) return Duration.min(SUMMARY_BACKSTOP, Duration.millis(untilDue));

    const unavailable = buildTextGenerationUnavailableReason(yield* models.resolve());
    if (unavailable !== null) return SUMMARY_BACKSTOP;
    const attempts = yield* promotion.whenServing(
      tasks.claimSummaryAttempts({ limit: SUMMARY_CONCURRENCY }),
    );
    // The read said a Task was due and the claim found none: it changed in
    // between. The next look settles it; a backstop sleep rules out a spin.
    if (attempts.length === 0) return SUMMARY_BACKSTOP;
    yield* Effect.forEach(
      attempts,
      (attempt) =>
        // One Task's failure, or its defect, must not stop the Task beside it.
        absorbFailures(
          `Writing the summary of Task ${attempt.taskId} failed`,
          writeSummary(attempt),
        ),
      { concurrency: SUMMARY_CONCURRENCY, discard: true },
    );
  }
});

/**
 * Writes the Task Summaries that are due. It looks once at the start, then
 * sleeps until the first Task becomes due, and wakes earlier when
 * `TaskSummaryWake` fires (a Task was marked) or after at most a minute.
 * Never returns. A round that fails is logged, and the next one runs after a
 * minute or the next wake.
 *
 * A Task is due 30 seconds after its first change since its last summary, and
 * a Task is tried at most once every 5 minutes, failures included (see
 * `TaskService.claimSummaryAttempts`). With the Text Generation Model Off, or
 * no runner able to run it, a round does nothing and leaves the Tasks dirty,
 * so the next wake after the setting changes finds the work still there.
 */
export const runTaskSummaryLoop: Effect.Effect<
  never,
  never,
  | TaskService
  | TextGeneration
  | TextGenerationModels
  | PromotionState
  | TaskTrackingRuns
  | SqlClient.SqlClient
> = Effect.gen(function* () {
  const wake = yield* TaskSummaryWake;
  while (true) {
    let sleepFor = SUMMARY_BACKSTOP;
    yield* absorbFailures(
      "A round of the summary writer failed",
      Effect.map(writeDueSummaries, (duration) => {
        sleepFor = duration;
      }),
    );
    yield* wake.awaitWake(sleepFor);
  }
});
