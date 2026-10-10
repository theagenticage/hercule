import { describe, expect, it } from "vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer } from "../../events";
import { ControllerIdentity } from "../../identity";
import { PromotionState, PromotionStateLayer } from "../../promotion";
import { thawExpiredFreezes } from "./freeze-expiry";

const TOKEN = "0199f0b7-0000-7000-8000-00000000aaaa";
const OTHER_TOKEN = "0199f0b7-0000-7000-8000-00000000bbbb";
const ONE_HOUR = 3_600_000;

/** A promotion state over an in-memory database. These tests never seal, so nothing signs. */
const PromotionStateForTest = PromotionStateLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(ControllerIdentity, {
        ensure: Effect.die("not used"),
        readOrDie: Effect.die("not used"),
        sign: () => Effect.die("not used"),
      }),
      AuditLogLayer,
    ),
  ),
  Layer.provideMerge(TestDatabase),
);

/** Returns a deadline `millis` after the clock's current time. */
const deadlineIn = (millis: number): Effect.Effect<Date> =>
  Effect.map(Clock.currentTimeMillis, (now) => new Date(now + millis));

/** Waits until the controller serves, including when it already does. */
const awaitServing = Effect.flatMap(PromotionState, (promotion) =>
  promotion.phaseChanges.pipe(
    Stream.filter((phase) => phase._tag === "Serving"),
    Stream.runHead,
    Effect.asVoid,
  ),
);

/**
 * Waits until the sleeps in progress, listed by the time each one ends,
 * match `matches`, including when they already do.
 */
type SleepsAwaiter = (matches: (endTimes: ReadonlyArray<number>) => boolean) => Effect.Effect<void>;

/**
 * Runs `body` with the expiry driver running beside it, and returns the
 * promotion phase once `body` has ended.
 *
 * The clock is a test clock, so time passes only when `body` moves it. The
 * clock also tracks the sleeps in progress on it, which `body` waits on
 * through the function it is given. The driver sleeps until a freeze's
 * deadline, so a sleep that ends at that deadline shows that the driver has
 * seen the freeze, and `body` can move the clock without racing it.
 */
const runWithDriver = (
  body: (awaitSleeps: SleepsAwaiter) => Effect.Effect<void, unknown, PromotionState>,
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const testClock = yield* TestClock.make();
      const sleepEndTimes = yield* SubscriptionRef.make<ReadonlyArray<number>>([]);
      const clock: TestClock.TestClock = {
        ...testClock,
        sleep: (duration) =>
          Effect.suspend(() => {
            const end = testClock.currentTimeMillisUnsafe() + Duration.toMillis(duration);
            return Effect.acquireUseRelease(
              SubscriptionRef.update(sleepEndTimes, (ends) => [...ends, end]),
              () => testClock.sleep(duration),
              () =>
                SubscriptionRef.update(sleepEndTimes, (ends) => {
                  const index = ends.indexOf(end);
                  return [...ends.slice(0, index), ...ends.slice(index + 1)];
                }),
            );
          }),
      };
      const awaitSleeps: SleepsAwaiter = (matches) =>
        SubscriptionRef.changes(sleepEndTimes).pipe(
          Stream.filter(matches),
          Stream.runHead,
          Effect.asVoid,
        );

      return yield* Effect.gen(function* () {
        const promotion = yield* PromotionState;
        yield* Effect.forkScoped(thawExpiredFreezes);
        yield* body(awaitSleeps);
        return (yield* promotion.phase)._tag;
      }).pipe(Effect.provideService(Clock.Clock, clock));
    }).pipe(Effect.scoped, Effect.provide(PromotionStateForTest)),
  );

describe("thawExpiredFreezes", () => {
  it("thaws a freeze when its deadline passes", async () => {
    const phase = await runWithDriver((awaitSleeps) =>
      Effect.gen(function* () {
        const promotion = yield* PromotionState;
        const deadline = yield* deadlineIn(50);
        yield* promotion.freeze(TOKEN, deadline);
        yield* awaitSleeps((ends) => ends.includes(deadline.getTime()));
        yield* TestClock.adjust(Duration.millis(50));
        yield* awaitServing;
      }),
    );
    expect(phase).toBe("Serving");
  });

  it("leaves a freeze alone before its deadline", async () => {
    const phase = await runWithDriver((awaitSleeps) =>
      Effect.gen(function* () {
        const promotion = yield* PromotionState;
        const deadline = yield* deadlineIn(ONE_HOUR);
        yield* promotion.freeze(TOKEN, deadline);
        yield* awaitSleeps((ends) => ends.includes(deadline.getTime()));
        yield* TestClock.adjust(Duration.millis(ONE_HOUR - 1));
      }),
    );
    expect(phase).toBe("Frozen");
  });

  it("never thaws a later freeze at the deadline of one that ended early", async () => {
    const phase = await runWithDriver((awaitSleeps) =>
      Effect.gen(function* () {
        const promotion = yield* PromotionState;
        const early = yield* deadlineIn(50);
        yield* promotion.freeze(TOKEN, early);
        yield* awaitSleeps((ends) => ends.includes(early.getTime()));
        yield* promotion.thaw(TOKEN);
        const later = yield* deadlineIn(ONE_HOUR);
        yield* promotion.freeze(OTHER_TOKEN, later);
        // The driver has dropped the wait for the first freeze and waits for
        // the second one's deadline only.
        yield* awaitSleeps(
          (ends) => ends.includes(later.getTime()) && !ends.includes(early.getTime()),
        );
        yield* TestClock.adjust(Duration.millis(150));
      }),
    );
    expect(phase).toBe("Frozen");
  });
});
