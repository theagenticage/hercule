/**
 * A helper for the tests of the connection: they wait for something a fiber
 * or a callback does, without sleeping and without polling.
 */
import * as Effect from "effect/Effect";

/**
 * Creates a notifier. Code that changes the state a test watches calls
 * `notifyChange()` after each change, and the test calls `waitUntil` to wait
 * for the state it expects.
 *
 * `waitUntil` fails the test with `what` in its message after ten seconds on
 * the real clock. A test that runs on the test clock never reaches that
 * limit, and then the test runner's own timeout ends the wait.
 */
export const createChangeNotifier = () => {
  let waiters: Array<() => void> = [];
  return {
    notifyChange: (): void => {
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
    },
    /** Waits until `ready()` is true. It checks `ready()` again after every `notifyChange()`. */
    waitUntil: (what: string, ready: () => boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (!ready()) {
          yield* Effect.callback<void>((resume) => {
            waiters.push(() => resume(Effect.void));
          });
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.die(new Error(`The test was stuck waiting until ${what}.`)),
        }),
      ),
  };
};
