/**
 * Tests for how long `send` waits for pi's response to each command, on an
 * in-memory pi whose responses the test controls and a clock the test moves.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createLines } from "./testing";
import { PROMPT_RPC_DEADLINE, RPC_DEADLINE, makeRpc } from "./rpc";

/** Builds an rpc over a pi that records its commands and responds only when the test says so. */
const createPeer = () => {
  const stdout = createLines();
  const writes: Array<Record<string, unknown>> = [];
  const rpc = makeRpc(
    {
      write: (text) => void writes.push(JSON.parse(text) as Record<string, unknown>),
      stdout: stdout.iterable,
      stderr: createLines().iterable,
      end: () => undefined,
      kill: () => undefined,
      exited: new Promise<number>(() => undefined),
    },
    () => undefined,
  );
  const respondToLast = (): void =>
    stdout.push(JSON.stringify({ type: "response", id: writes.at(-1)!["id"], success: true }));
  return { rpc, respondToLast };
};

describe("the time pi gets to respond to a command", () => {
  it("fails a command that pi answers from its own state when it is silent for 5 seconds", async () => {
    const { rpc } = createPeer();
    const failure = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pumping = yield* Effect.forkChild(rpc.pump);
          const sent = yield* Effect.forkChild(
            Effect.flip(rpc.send({ type: "steer", message: "x" })),
          );
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(RPC_DEADLINE);
          const error = yield* Fiber.join(sent);
          yield* Fiber.interrupt(pumping);
          return error;
        }),
        TestClock.layer(),
      ),
    );
    expect(failure._tag).toBe("PiTimedOut");
  });

  it("delivers a prompt that pi acknowledges after compacting for a minute", async () => {
    const { rpc, respondToLast } = createPeer();
    const response = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pumping = yield* Effect.forkChild(rpc.pump);
          const sent = yield* Effect.forkChild(rpc.send({ type: "prompt", message: "x" }));
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(Duration.minutes(1));
          respondToLast();
          const answered = yield* Fiber.join(sent);
          yield* Fiber.interrupt(pumping);
          return answered;
        }),
        TestClock.layer(),
      ),
    );
    expect(response["success"]).toBe(true);
  });

  it("fails a prompt that pi never acknowledges once its longer wait is over", async () => {
    const { rpc } = createPeer();
    const failure = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pumping = yield* Effect.forkChild(rpc.pump);
          const sent = yield* Effect.forkChild(
            Effect.flip(rpc.send({ type: "prompt", message: "x" })),
          );
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(PROMPT_RPC_DEADLINE);
          const error = yield* Fiber.join(sent);
          yield* Fiber.interrupt(pumping);
          return error;
        }),
        TestClock.layer(),
      ),
    );
    expect(failure._tag).toBe("PiTimedOut");
  });
});
