import { describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer } from "../../events";
import { ControllerIdentity } from "../../identity";
import { PromotionExpiry, PromotionState, PromotionStateLayer } from "../../promotion";
import { PromotionExpiryLayer } from "./promotion-expiry";

const TOKEN = "0199f0b7-0000-7000-8000-00000000aaaa";

const StateDependencies = Layer.mergeAll(
  Layer.succeed(ControllerIdentity, {
    ensure: Effect.die("not used"),
    readOrDie: Effect.die("not used"),
    sign: () => Effect.succeed(new Uint8Array(64).fill(7)),
  }),
  AuditLogLayer,
);

describe("PromotionExpiry", () => {
  it("thaws the freeze at the deadline it was given", async () => {
    const phase = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        const expiry = yield* PromotionExpiry;
        yield* state.freeze(TOKEN);
        yield* expiry.scheduleThaw(TOKEN, new Date(Date.now() + 50));
        yield* Effect.sleep(Duration.millis(150));
        return (yield* state.phase)._tag;
      }).pipe(
        Effect.provide(
          PromotionExpiryLayer.pipe(
            Layer.provideMerge(PromotionStateLayer.pipe(Layer.provideMerge(StateDependencies))),
          ),
        ),
        Effect.provide(TestDatabase),
      ),
    );
    expect(phase).toBe("Serving");
  });
});
