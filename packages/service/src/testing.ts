/**
 * Test helpers for the Supervisor implementations. Imported only by
 * `*.test.ts`. Nothing here runs a real command.
 */
import { Clock, Duration, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import type { CommandResult } from "./supervisor";

/** How many half-second steps `runOnTestClock` takes before it gives up. */
const MAX_STEPS = 1000;

/** Builds the result of one run of a fake command. */
export const buildCommandResult = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

/**
 * Runs an effect on a `TestClock`, moving the clock half a second at a time
 * until the effect is done, and returns its result and how many seconds of
 * clock time it took. The waits poll every half second, so each step lets
 * exactly one poll run. Throws when the effect is still running after
 * `MAX_STEPS`, so a wait that never ends fails the test instead of hanging it.
 */
export const runOnTestClock = <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<{ readonly result: Result.Result<A, E>; readonly seconds: number }> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const fiber = yield* Effect.forkChild(Effect.result(effect));
        // Lets the effect run up to its first sleep before the clock moves at all.
        yield* Effect.yieldNow;
        for (let step = 0; fiber.pollUnsafe() === undefined; step += 1) {
          if (step >= MAX_STEPS) {
            return yield* Effect.die(
              new Error(`The effect still runs after ${MAX_STEPS / 2} seconds of clock time.`),
            );
          }
          yield* TestClock.adjust(Duration.millis(500));
        }
        const result = yield* Fiber.join(fiber);
        const ended = yield* Clock.currentTimeMillis;
        return { result, seconds: (ended - started) / 1000 };
      }),
      TestClock.layer(),
    ),
  );

/** Returns the value of a successful result, and throws when the result is a failure. */
export const expectSuccess = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) {
    throw new Error(
      `Expected a success, and the result is the failure ${JSON.stringify(result.failure)}`,
    );
  }
  return result.success;
};

/** Returns the message of a failed result, and throws when the result is a success. */
export const readFailureMessage = <A, E extends { readonly message: string }>(
  result: Result.Result<A, E>,
): string => {
  if (Result.isSuccess(result)) throw new Error("Expected a failure, and the result is a success.");
  return result.failure.message;
};
