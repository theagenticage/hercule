/**
 * Tests when the latest releases of the harnesses are read: every harness at
 * start and then every hour, and a pass that fails does not stop the next
 * one. The reads themselves are counted with a stand-in for
 * `HarnessReleases`; what a read stores is tested with the real one.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../../db/testing";
import { HarnessReleases } from "../../harnesses";
import { ServingPromotionStateLayer } from "../../promotion/testing";
import { runHarnessReleaseCheckLoop } from "./release-check-loop";

/**
 * Runs the loop on a test clock, and returns how many reads had started right
 * after the start and after each minute in `checkpoints`. `readOnPass` is what
 * the nth read does.
 */
const countReadsAt = (
  checkpoints: ReadonlyArray<number>,
  readOnPass: (pass: number) => Effect.Effect<void>,
) => {
  let reads = 0;
  const releases = Layer.succeed(HarnessReleases)({
    refreshLatestReleases: () =>
      Effect.suspend(() => {
        reads += 1;
        return readOnPass(reads);
      }),
  });
  const layer = Layer.merge(releases, ServingPromotionStateLayer).pipe(
    Layer.provideMerge(TestDatabase),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const loop = yield* Effect.forkChild(runHarnessReleaseCheckLoop);
      yield* TestClock.adjust(Duration.zero);
      const counts: Array<number> = [reads];
      let minute = 0;
      for (const checkpoint of checkpoints) {
        yield* TestClock.adjust(Duration.minutes(checkpoint - minute));
        minute = checkpoint;
        counts.push(reads);
      }
      yield* Fiber.interrupt(loop);
      return counts;
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.orDie),
  );
};

describe("runHarnessReleaseCheckLoop", () => {
  it("reads every harness at once, then again every hour and not before", async () => {
    const counts = await countReadsAt([59, 60, 119, 120], () => Effect.void);

    expect(counts).toEqual([1, 1, 2, 2, 3]);
  });

  it("reads again an hour later when a pass fails", async () => {
    const counts = await countReadsAt([60], (pass) =>
      pass === 1 ? Effect.die("the registry broke") : Effect.void,
    );

    expect(counts).toEqual([1, 2]);
  });
});
