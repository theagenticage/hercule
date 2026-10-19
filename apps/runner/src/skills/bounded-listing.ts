/**
 * Bounds every read of a workspace's skill folders on this runner: how many
 * run at the same time, and how long one may take.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";

/**
 * How long one bounded read may take, from the request to the answer,
 * including the wait for a place to read. It is a second shorter than the 10
 * seconds the controller waits for the answer to an inspection, so the runner
 * answers `failed` with a reason before the controller gives up with a vaguer
 * one.
 */
const LISTING_TIMEOUT: Duration.Duration = Duration.seconds(9);

/** The most bounded reads the runner makes at the same time, whoever asks. */
const MAX_PARALLEL_LISTINGS = 4;

/**
 * Held by every bounded read while it reads, until its file system calls have
 * really stopped. A read that takes too long is aborted and answered at
 * `LISTING_TIMEOUT`, but it keeps its place until the last call it made
 * returns, so reads that hang on a stalled disk cannot pile up beyond this
 * limit. Inspections and previews (each walks the files of up to 32 checkouts)
 * and session starts all share it, so a burst of requests cannot use the
 * runner's disk for the sessions it hosts. One semaphore serves all callers,
 * not one per caller.
 */
const listings = Semaphore.makeUnsafe(MAX_PARALLEL_LISTINGS);

const SLOW_LISTING = `reading the workspace's skill folders took longer than ${String(Duration.toSeconds(LISTING_TIMEOUT))} seconds`;

const BUSY_RUNNER = `the runner is still busy reading skill folders for earlier requests; try again in a moment`;

/**
 * Runs a read of the workspace's skill folders in a place of `listings` and
 * returns what it returns. Fails with the read's own message, or with a
 * message that says why the read did not finish.
 *
 * The read runs in a fiber of its own. If it has not finished after
 * `LISTING_TIMEOUT`, counted from this call, the call fails and the fiber is
 * interrupted in the background: the read aborts, and gives its place back
 * only when it has stopped. The failure says whether the read was running
 * (`SLOW_LISTING`) or still waiting for a place (`BUSY_RUNNER`), in which case
 * nothing was read.
 */
export const runBoundedListing = <A>(listing: Effect.Effect<A, string>): Effect.Effect<A, string> =>
  Effect.gen(function* () {
    let hasStarted = false;
    const fiber = yield* Effect.forkDetach(
      listings.withPermits(1)(
        Effect.suspend(() => {
          hasStarted = true;
          return listing;
        }),
      ),
    );
    return yield* Fiber.join(fiber).pipe(
      Effect.timeoutOrElse({
        duration: LISTING_TIMEOUT,
        orElse: () => Effect.fail(hasStarted ? SLOW_LISTING : BUSY_RUNNER),
      }),
      // Also runs when the request itself is interrupted. Joining a fiber does not stop it.
      Effect.ensuring(Effect.asVoid(Effect.forkDetach(Fiber.interrupt(fiber)))),
    );
  });
