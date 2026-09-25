/**
 * Tests the Run Executor with real fibers and an execution the test controls:
 * each pass of the execution announces that it started, then waits until the
 * test lets it finish. No test waits a fixed time.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, FiberMap, Queue } from "effect";
import { RunExecutor } from "../../runs";
import { RunExecutorLayer, RunFibers } from "./executor";

/**
 * Builds an execution whose passes the test steps through. `started` receives
 * the number of each pass as it begins, and pass `n` ends when `finish(n)` is
 * called. `mostAtOnce` is the most passes that were ever running together.
 */
const buildControlledExecution = Effect.gen(function* () {
  const started = yield* Queue.unbounded<number>();
  const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
  let passes = 0;
  let running = 0;
  let mostAtOnce = 0;
  const execution = Effect.gen(function* () {
    passes += 1;
    running += 1;
    mostAtOnce = Math.max(mostAtOnce, running);
    const gate = gates[passes - 1] ?? (yield* Deferred.make<void>());
    yield* Queue.offer(started, passes);
    yield* Deferred.await(gate);
    running -= 1;
  });
  return {
    execution,
    started,
    finish: (pass: number) => Deferred.succeed(gates[pass - 1]!, undefined),
    passes: () => passes,
    mostAtOnce: () => mostAtOnce,
  };
});

const runWithExecutor = <A, E>(body: Effect.Effect<A, E, RunExecutor | RunFibers>): Promise<A> =>
  Effect.runPromise(Effect.provide(body, RunExecutorLayer));

describe("RunExecutor", () => {
  it("runs one more pass when woken during a pass, however many times it was woken", async () => {
    const result = await runWithExecutor(
      Effect.gen(function* () {
        const executor = yield* RunExecutor;
        const runFibers = yield* RunFibers;
        const controlled = yield* buildControlledExecution;

        executor.execute("run-1", controlled.execution);
        expect(yield* Queue.take(controlled.started)).toBe(1);
        // Three step results committed while the first pass is running.
        executor.execute("run-1", controlled.execution);
        executor.execute("run-1", controlled.execution);
        executor.execute("run-1", controlled.execution);
        yield* controlled.finish(1);
        expect(yield* Queue.take(controlled.started)).toBe(2);
        yield* controlled.finish(2);
        yield* FiberMap.awaitEmpty(runFibers);

        // The run fell asleep; a later wake-up starts it again.
        executor.execute("run-1", controlled.execution);
        expect(yield* Queue.take(controlled.started)).toBe(3);
        return { passes: controlled.passes(), mostAtOnce: controlled.mostAtOnce() };
      }),
    );

    expect(result).toEqual({ passes: 3, mostAtOnce: 1 });
  });

  it("starts a run again after it was stopped mid-pass", async () => {
    const passes = await runWithExecutor(
      Effect.gen(function* () {
        const executor = yield* RunExecutor;
        const controlled = yield* buildControlledExecution;

        executor.execute("run-1", controlled.execution);
        expect(yield* Queue.take(controlled.started)).toBe(1);
        executor.stop(["run-1"]);
        executor.execute("run-1", controlled.execution);
        expect(yield* Queue.take(controlled.started)).toBe(2);
        return controlled.passes();
      }),
    );

    expect(passes).toBe(2);
  });
});
