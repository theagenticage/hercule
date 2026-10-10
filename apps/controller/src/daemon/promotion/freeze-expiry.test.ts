import { describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer } from "../../events";
import { ControllerIdentity } from "../../identity";
import { PromotionState, PromotionStateLayer } from "../../promotion";
import { thawExpiredFreezes } from "./freeze-expiry";

const TOKEN = "0199f0b7-0000-7000-8000-00000000aaaa";
const OTHER_TOKEN = "0199f0b7-0000-7000-8000-00000000bbbb";

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

/** Returns a deadline `millis` from now. */
const inMillis = (millis: number): Date => new Date(Date.now() + millis);

/**
 * Runs `body` with the expiry driver running beside it, and returns the
 * promotion phase once `body` has ended.
 */
const runWithDriver = (body: Effect.Effect<void, unknown, PromotionState>): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const promotion = yield* PromotionState;
      yield* Effect.forkScoped(thawExpiredFreezes);
      yield* body;
      return (yield* promotion.phase)._tag;
    }).pipe(Effect.scoped, Effect.provide(PromotionStateForTest)),
  );

describe("thawExpiredFreezes", () => {
  it("thaws a freeze when its deadline passes", async () => {
    const phase = await runWithDriver(
      Effect.gen(function* () {
        const promotion = yield* PromotionState;
        yield* promotion.freeze(TOKEN, inMillis(50));
        yield* Effect.sleep(Duration.millis(150));
      }),
    );
    expect(phase).toBe("Serving");
  });

  it("leaves a freeze alone before its deadline", async () => {
    const phase = await runWithDriver(
      Effect.gen(function* () {
        const promotion = yield* PromotionState;
        yield* promotion.freeze(TOKEN, inMillis(3_600_000));
        yield* Effect.sleep(Duration.millis(100));
      }),
    );
    expect(phase).toBe("Frozen");
  });

  it("never thaws a later freeze at the deadline of one that ended early", async () => {
    const phase = await runWithDriver(
      Effect.gen(function* () {
        const promotion = yield* PromotionState;
        yield* promotion.freeze(TOKEN, inMillis(50));
        yield* promotion.thaw(TOKEN);
        yield* promotion.freeze(OTHER_TOKEN, inMillis(3_600_000));
        yield* Effect.sleep(Duration.millis(150));
      }),
    );
    expect(phase).toBe("Frozen");
  });
});
