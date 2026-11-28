/**
 * Tests for how long `send` waits for pi's response to a command, on an
 * in-memory pi whose responses the test controls and a clock the test moves.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createLines } from "./testing";
import { RPC_DEADLINE, makeRpc } from "./rpc";

/** Builds an rpc over a pi that records its commands and responds only when the test says so. */
const createPeer = (onLine: (line: string, frame: unknown) => void = () => undefined) => {
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
    onLine,
  );
  const respondToLast = (): void =>
    stdout.push(JSON.stringify({ type: "response", id: writes.at(-1)!["id"], success: true }));
  return { rpc, respondToLast, stdout };
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

  it("fails a prompt that pi does not acknowledge within 5 seconds", async () => {
    const { rpc } = createPeer();
    const failure = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pumping = yield* Effect.forkChild(rpc.pump);
          const sent = yield* Effect.forkChild(
            Effect.flip(rpc.send({ type: "prompt", message: "x" })),
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
});

describe("the lines pi writes that are not responses", () => {
  it("hands every JSON value that is not a response object to the line reader, null included", async () => {
    const frames: Array<unknown> = [];
    const { rpc, stdout } = createPeer((_line, frame) => void frames.push(frame));

    stdout.push("null");
    stdout.push("5");
    stdout.push('{"type":"agent_start"}');
    stdout.push('{"type":"response","id":"nobody","success":true}');
    stdout.end();
    await Effect.runPromise(rpc.pump);

    expect(frames).toEqual([null, 5, { type: "agent_start" }]);
  });
});
