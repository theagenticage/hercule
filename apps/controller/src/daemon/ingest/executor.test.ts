/**
 * Tests the Ingest Executor with real fibers and an ingest the test controls:
 * the ingest announces that it started, then waits until it is interrupted.
 * No test waits a fixed time.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect } from "effect";
import { IngestExecutor } from "../../plugins";
import { IngestExecutorLayer } from "./executor";

const runWithExecutor = <A, E>(body: Effect.Effect<A, E, IngestExecutor>): Promise<A> =>
  Effect.runPromise(Effect.provide(body, IngestExecutorLayer));

describe("IngestExecutor", () => {
  it("returns from stop only once the ingest's finalizer has run", async () => {
    const finalized = await runWithExecutor(
      Effect.gen(function* () {
        const executor = yield* IngestExecutor;
        const started = yield* Deferred.make<void>();
        let finalized = false;
        const ingest = Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
          Effect.ensuring(
            // The finalizer waits, as a handle's `close` does, so `stop`
            // returning early would show here.
            Effect.andThen(
              Effect.yieldNow,
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          ),
        );

        yield* executor.execute("connection-1", ingest);
        yield* Deferred.await(started);
        yield* executor.stop("connection-1");
        return finalized;
      }),
    );

    expect(finalized).toBe(true);
  });

  it("runs an ingest again for a Connection whose ingest ended by itself", async () => {
    const runs = await runWithExecutor(
      Effect.gen(function* () {
        const executor = yield* IngestExecutor;
        let runs = 0;
        const ended = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const ingest = Effect.suspend(() => {
          runs += 1;
          return Deferred.succeed(ended[runs - 1]!, undefined);
        });

        yield* executor.execute("connection-1", ingest);
        yield* Deferred.await(ended[0]!);
        yield* executor.execute("connection-1", ingest);
        yield* Deferred.await(ended[1]!);
        return runs;
      }),
    );

    expect(runs).toBe(2);
  });

  it("does nothing when stopping a Connection with no ingest", async () => {
    await runWithExecutor(Effect.flatMap(IngestExecutor, (executor) => executor.stop("unknown")));
  });
});
