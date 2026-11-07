/**
 * The periodic read of the latest release of every harness (spec 06 section
 * 2): every installed harness, enabled or not, at controller start and then
 * every hour. Installed means compiled into the binary, so the list is fixed
 * when the controller starts and enabling a plugin never adds a harness to
 * read.
 *
 * What is read and what is stored is decided by
 * `HarnessReleases.refreshLatestReleases`. This module only repeats it.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HarnessReleases } from "../../harnesses";
import { PromotionState } from "../../promotion";
import { absorbFailures } from "../../absorbing";

/** How often the latest releases are read. Three small requests an hour. */
const HARNESS_RELEASE_CHECK_INTERVAL: Duration.Duration = Duration.hours(1);

/**
 * Reads the latest release of every harness at once, then again after each
 * `HARNESS_RELEASE_CHECK_INTERVAL`. Never returns. A pass that fails is
 * logged, and the next one runs.
 *
 * A pass starts only while the controller serves, and never once it is
 * sealed. The pass itself is not counted as running work, because a freeze
 * must not wait for a slow registry. So a pass can still finish after a
 * freeze began: until the database is copied its result is stored as usual,
 * and once the copy is made the write is refused, logged, and repeated by the
 * next pass.
 */
export const runHarnessReleaseCheckLoop: Effect.Effect<
  never,
  never,
  HarnessReleases | PromotionState
> = Effect.gen(function* () {
  const releases = yield* HarnessReleases;
  const promotion = yield* PromotionState;
  while (true) {
    // Only waits until the controller serves. The pass is not run inside
    // `whenServing`, because that would make a freeze wait for it.
    yield* promotion.whenServing(Effect.void);
    yield* absorbFailures(
      "Reading the latest releases of the harnesses failed",
      releases.refreshLatestReleases(),
    );
    yield* Effect.sleep(HARNESS_RELEASE_CHECK_INTERVAL);
  }
});
