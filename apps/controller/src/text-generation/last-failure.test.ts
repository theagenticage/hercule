import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { LastTextGenerationFailure, LastTextGenerationFailureLayer } from "./last-failure";

const run = <A>(effect: Effect.Effect<A, never, LastTextGenerationFailure>) =>
  Effect.runPromise(Effect.provide(effect, LastTextGenerationFailureLayer));

describe("the last text generation failure", () => {
  it("is null until a call fails", async () => {
    const last = await run(
      Effect.flatMap(LastTextGenerationFailure, (one) => one.read("automatic")),
    );

    expect(last).toBeNull();
  });

  it("holds the latest failure, and is forgotten when a call succeeds", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const failure = yield* LastTextGenerationFailure;
        yield* failure.record("automatic", {
          reason: "timeout",
          message: "first",
          at: "2026-10-11T10:00:00.000Z",
        });
        yield* failure.record("automatic", {
          reason: "unavailable",
          message: "second",
          at: "2026-10-11T10:01:00.000Z",
        });
        const held = yield* failure.read("automatic");
        yield* failure.clear();
        return { held, cleared: yield* failure.read("automatic") };
      }),
    );

    expect(seen.held).toEqual({
      reason: "unavailable",
      message: "second",
      at: "2026-10-11T10:01:00.000Z",
    });
    expect(seen.cleared).toBeNull();
  });

  it("is not shown for another value of the setting", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const failure = yield* LastTextGenerationFailure;
        yield* failure.record('"automatic"', {
          reason: "timeout",
          message: "slow",
          at: "2026-10-11T10:00:00.000Z",
        });
        return yield* failure.read('{"instanceId":"x","model":"y"}');
      }),
    );

    expect(seen).toBeNull();
  });
});
