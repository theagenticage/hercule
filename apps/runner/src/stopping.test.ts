/**
 * F-41: the one thing `stopping` is for - `work` outlives `shutdown` starting,
 * not just the signal that triggers it.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import { stopping } from "./stopping";

describe("stopping", () => {
  it("does not interrupt work until the shutdown it is racing has returned", async () => {
    const order: Array<string> = [];
    const latch = Latch.makeUnsafe(false);
    const work = Effect.onInterrupt(Effect.never, () =>
      Effect.sync(() => order.push("work interrupted")),
    );
    const shutdown = Effect.andThen(
      latch.await,
      Effect.sync(() => order.push("shutdown returned")),
    );

    const fiber = Effect.runFork(stopping(work, shutdown));
    latch.openUnsafe();
    await Effect.runPromise(Fiber.await(fiber));

    expect(order).toEqual(["shutdown returned", "work interrupted"]);
  });
});
