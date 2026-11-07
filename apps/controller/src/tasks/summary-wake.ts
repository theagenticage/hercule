/**
 * The signal that tells the summary writer a Task was marked dirty.
 *
 * `TaskService.markSummaryDirty` calls `wake` after its transaction commits.
 * The writer calls `awaitWake` between rounds: it returns at the next `wake`,
 * or after the backstop time when none comes, so a wake lost to a crash or a
 * missed signal costs a delay and never a summary.
 *
 * It is a `Context.Reference` with a default, so the one process-wide wake
 * reaches the task service and the writer without being wired into every layer
 * that builds the task service. A test that wants a wake of its own provides
 * one. A wake that nobody awaits is harmless: the writer reads the database
 * after each wake, so a spurious wake only makes it look once more.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";

export interface SummaryWake {
  /** Opens the wake. Synchronous, and safe to call from a commit callback. */
  readonly wake: () => void;
  /**
   * Waits until the wake is opened or `backstop` has passed, then closes the
   * wake again. A `wake` that came while nobody waited is not lost: the next
   * call returns at once.
   *
   * The wake closes before the caller reads the database, so a Task marked
   * dirty after that read opens it again, and no change is missed.
   */
  readonly awaitWake: (backstop: Duration.Input) => Effect.Effect<void>;
}

/**
 * Builds a wake of its own. The process shares one (`TaskSummaryWake`'s
 * default); a test that needs a wake no other test touches builds one.
 */
export const makeSummaryWake = (): SummaryWake => {
  const latch = Latch.makeUnsafe(false);
  return {
    wake: () => {
      latch.openUnsafe();
    },
    awaitWake: (backstop) =>
      latch.await.pipe(
        Effect.timeoutOption(Duration.fromInputUnsafe(backstop)),
        Effect.andThen(latch.close),
        Effect.asVoid,
      ),
  };
};

export const TaskSummaryWake = Context.Reference<SummaryWake>(
  "hercule/controller/tasks/TaskSummaryWake",
  { defaultValue: makeSummaryWake },
);
