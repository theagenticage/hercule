/**
 * The summary writer: the loop that keeps the Task Summaries current.
 *
 * The tasks domain keeps the bookkeeping in `task_summaries` and the rules for
 * writing from it (`TaskSummaries.writeDue`): which Tasks are due, how often
 * each may be tried, and what happens to a late answer. This loop does the
 * part a domain cannot do, because it runs for the life of the controller and
 * waits on a model: it supplies the describer, which makes one Text Generation
 * per Task, and sleeps until the next Task is due or a Task is marked.
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
import type * as SqlClient from "effect/sql/SqlClient";
import {
  TaskSummaries,
  TaskSummaryWake,
  type SummaryDescriber,
  type TaskTrackingRuns,
} from "../../tasks";
import {
  buildTextGenerationUnavailableReason,
  TextGeneration,
  TextGenerationModels,
} from "../../text-generation";
import { absorbFailures } from "../../absorbing";
import { buildTaskSummaryCall, parseSummaryAnswer } from "./summary-input";

/**
 * The longest the loop sleeps without a wake. It sleeps until the first Task
 * is due, which can be an hour away after failures. A wake lost to a crash, or
 * a Text Generation Model that was Off, costs this delay at most.
 */
const SUMMARY_BACKSTOP = Duration.minutes(1);

/**
 * The describer the tasks domain writes summaries with. `describe` makes one
 * Text Generation call from the Task's summary input and parses the answer; it
 * fails with the reason when the call or the answer is no good. `canDescribe`
 * uses the same reason `controller.read` reports for a Text Generation Model
 * that is Off, or that no runner can run now.
 */
const buildDescriber = Effect.gen(function* () {
  const generation = yield* TextGeneration;
  const models = yield* TextGenerationModels;
  const inputServices = yield* Effect.context<SqlClient.SqlClient | TaskTrackingRuns>();
  return {
    canDescribe: Effect.suspend(() =>
      Effect.map(
        models.resolve(),
        (resolved) => buildTextGenerationUnavailableReason(resolved) === null,
      ),
    ),
    describe: (taskId) =>
      Effect.gen(function* () {
        const call = yield* buildTaskSummaryCall(taskId).pipe(
          Effect.provide(inputServices),
          Effect.orDie,
        );
        // A Task that no longer exists has nothing to describe. The failure is
        // dropped by the domain, which records nothing for a Task that is not live.
        if (Option.isNone(call)) return yield* Effect.fail("the Task no longer exists");
        const answer = yield* generation
          .generate(call.value)
          .pipe(Effect.mapError((error) => `${error.reason}: ${error.message}`));
        return yield* Effect.try({
          try: () => parseSummaryAnswer(answer),
          catch: () => "the model's answer did not hold the three texts of a summary",
        });
      }),
  } satisfies SummaryDescriber;
});

/**
 * Writes the summaries that are due (see `TaskSummaries.writeDue`). Returns how
 * long to sleep before the next look: until the first Task becomes due, but at
 * most `SUMMARY_BACKSTOP`. When Tasks are still due, because no model can run
 * or the claim found none, it sleeps the backstop, so the loop never spins.
 * The next wake, such as the one after the setting changes, finds them still
 * there.
 */
const writeDueSummaries = Effect.gen(function* () {
  const summaries = yield* TaskSummaries;
  const describer = yield* buildDescriber;
  const dueAt = yield* summaries.writeDue(describer);
  if (Option.isNone(dueAt)) return SUMMARY_BACKSTOP;
  const untilDue = Date.parse(dueAt.value) - (yield* Clock.currentTimeMillis);
  return untilDue > 0
    ? Duration.min(SUMMARY_BACKSTOP, Duration.millis(untilDue))
    : SUMMARY_BACKSTOP;
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
 * `TaskSummaries.writeDue`). With the Text Generation Model Off, or
 * no runner able to run it, a round does nothing and leaves the Tasks dirty,
 * so the next wake after the setting changes finds the work still there.
 */
export const runTaskSummaryLoop: Effect.Effect<
  never,
  never,
  TaskSummaries | TextGeneration | TextGenerationModels | TaskTrackingRuns | SqlClient.SqlClient
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
