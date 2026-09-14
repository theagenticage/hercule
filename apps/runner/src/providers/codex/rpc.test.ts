/**
 * The Hydra-owned newline-delimited JSON-RPC codec, driven over a pair of
 * in-memory line streams: what it writes, how it sorts what comes back, and
 * what it does with a peer that answers late, badly, or not at all.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { RPC_DEADLINE, rpcOver, type Rpc } from "./rpc";

/** A stream of lines a test pushes into, read once by the codec. */
const lines = (): {
  readonly push: (line: string) => void;
  readonly end: () => void;
  readonly iterable: AsyncIterable<string>;
} => {
  const queued: Array<string> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const woken = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  return {
    push: (line) => {
      queued.push(line);
      woken();
    },
    end: () => {
      ended = true;
      woken();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queued.length > 0) yield queued.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
};

interface Peer {
  readonly rpc: Rpc;
  /** What the peer would read on its stdin, verbatim. */
  readonly writes: Array<string>;
  readonly answer: (line: string) => void;
  readonly warnings: Array<string>;
  readonly serverRequests: Array<{ readonly id: string | number; readonly method: string }>;
  readonly notifications: Array<{ readonly method: string; readonly params: unknown }>;
}

const peering = (): Peer => {
  const stdout = lines();
  const writes: Array<string> = [];
  const warnings: Array<string> = [];
  const serverRequests: Array<{ readonly id: string | number; readonly method: string }> = [];
  const notifications: Array<{ readonly method: string; readonly params: unknown }> = [];
  const rpc = rpcOver(
    {
      write: (text: string) => void writes.push(text),
      stdout: stdout.iterable,
    },
    {
      onServerRequest: (frame) => void serverRequests.push(frame),
      onNotification: (frame) => void notifications.push(frame),
      onWarning: (message) => void warnings.push(message),
    },
  );
  return { rpc, writes, answer: stdout.push, warnings, serverRequests, notifications };
};

const WAIT_MS = 5_000;

/** Waits for something the codec has done, or gives up and says what it was. */
const until = (what: string, ready: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + WAIT_MS;
    while (!ready() && Date.now() < deadline) yield* Effect.sleep(1);
    expect(ready(), `the codec never ${what}`).toBe(true);
  });

const frameOf = (written: string): Record<string, unknown> =>
  JSON.parse(written) as Record<string, unknown>;

/** A peer whose stdin has closed: every write to it throws. */
const deaf = (): Peer => {
  const stdout = lines();
  const warnings: Array<string> = [];
  const rpc = rpcOver(
    {
      write: () => {
        throw new Error("EPIPE");
      },
      stdout: stdout.iterable,
    },
    {
      onServerRequest: () => undefined,
      onNotification: () => undefined,
      onWarning: (message) => void warnings.push(message),
    },
  );
  return {
    rpc,
    writes: [],
    answer: stdout.push,
    warnings,
    serverRequests: [],
    notifications: [],
  };
};

describe("a peer that cannot be written to", () => {
  it("reports it once and throws at nobody", () => {
    const peer = deaf();

    // A reply thrown out of would be a defect in whoever was answering a
    // request, and the turn it belonged to would hang either way.
    expect(() => peer.rpc.answer(1, { result: {} })).not.toThrow();
    expect(() => peer.rpc.notify("initialized")).not.toThrow();
    expect(() => peer.rpc.answer(2, { error: { message: "no" } })).not.toThrow();

    // Once: a closed pipe fails every write after it for the same reason.
    expect(peer.warnings).toHaveLength(1);
    expect(peer.warnings[0]).toContain("EPIPE");
  });

  it("fails the request it could not send", async () => {
    const peer = deaf();

    const failure = await Effect.runPromise(Effect.flip(peer.rpc.request("initialize", {})));

    expect(failure.message).toContain("EPIPE");
  });
});

describe("what the codec writes", () => {
  it("writes one line per request, with no jsonrpc key on it", async () => {
    const peer = peering();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        const asked = yield* Effect.forkChild(
          peer.rpc.request("initialize", { clientInfo: { name: "hydra" } }),
        );
        yield* until("wrote the request", () => peer.writes.length === 1);

        const written = peer.writes[0]!;
        // Line-delimited: the peer reads one frame per newline and nothing else.
        expect(written.endsWith("\n")).toBe(true);
        expect(written.trimEnd()).not.toContain("\n");
        const frame = frameOf(written);
        expect(typeof frame["id"]).toBe("number");
        expect(frame["method"]).toBe("initialize");
        expect(frame["params"]).toEqual({ clientInfo: { name: "hydra" } });
        // Codex omits it in both directions, and rejects nothing for its absence.
        expect(Object.keys(frame)).not.toContain("jsonrpc");

        peer.answer(JSON.stringify({ id: frame["id"], result: { userAgent: "hydra/0.154.0" } }));
        const answered = yield* Fiber.join(asked);
        expect(answered).toEqual({ userAgent: "hydra/0.154.0" });
        yield* Fiber.interrupt(pumping);
      }),
    );
  });

  it("mints a fresh id per request, so two in flight do not answer each other", async () => {
    const peer = peering();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        const first = yield* Effect.forkChild(peer.rpc.request("account/read", {}));
        const second = yield* Effect.forkChild(peer.rpc.request("model/list", {}));
        yield* until("wrote both requests", () => peer.writes.length === 2);

        const ids = peer.writes.map((written) => frameOf(written)["id"]);
        expect(new Set(ids).size).toBe(2);

        // Answered out of order, which is what the ids are for.
        peer.answer(JSON.stringify({ id: ids[1], result: { data: [] } }));
        peer.answer(JSON.stringify({ id: ids[0], result: { account: null } }));
        expect(yield* Fiber.join(first)).toEqual({ account: null });
        expect(yield* Fiber.join(second)).toEqual({ data: [] });
        yield* Fiber.interrupt(pumping);
      }),
    );
  });
});

describe("how the codec sorts what comes back", () => {
  it("fails the request an error reply names, with the code and the message", async () => {
    const peer = peering();

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        const asked = yield* Effect.forkChild(
          Effect.flip(peer.rpc.request("turn/start", { threadId: "t-1" })),
        );
        yield* until("wrote the request", () => peer.writes.length === 1);

        peer.answer(
          JSON.stringify({
            error: { code: -32600, message: "thread not found: 00000000-0000-0000-0000-0" },
            id: frameOf(peer.writes[0]!)["id"],
          }),
        );
        const error = yield* Fiber.join(asked);
        yield* Fiber.interrupt(pumping);
        return error;
      }),
    );

    expect(failure).toMatchObject({
      code: -32600,
      message: "thread not found: 00000000-0000-0000-0000-0",
    });
  });

  it("delivers a frame with a method and an id as a server request", async () => {
    const peer = peering();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        peer.answer(
          JSON.stringify({
            id: 7,
            method: "item/commandExecution/requestApproval",
            params: { command: ["rm", "-rf", "."] },
          }),
        );
        yield* until("delivered the server request", () => peer.serverRequests.length === 1);
        yield* Fiber.interrupt(pumping);
      }),
    );

    expect(peer.serverRequests[0]).toMatchObject({
      id: 7,
      method: "item/commandExecution/requestApproval",
    });
    // A request answered as a notification would hang the turn for ever.
    expect(peer.notifications).toEqual([]);
  });

  it("delivers a frame with a method and no id as a notification", async () => {
    const peer = peering();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        peer.answer(
          JSON.stringify({
            method: "remoteControl/status/changed",
            params: { status: "disabled" },
          }),
        );
        yield* until("delivered the notification", () => peer.notifications.length === 1);
        yield* Fiber.interrupt(pumping);
      }),
    );

    expect(peer.notifications[0]).toEqual({
      method: "remoteControl/status/changed",
      params: { status: "disabled" },
    });
    expect(peer.serverRequests).toEqual([]);
  });
});

describe("a peer that answers badly, or not at all", () => {
  it("warns once about a line that is not JSON, and keeps reading the stream", async () => {
    const peer = peering();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        const asked = yield* Effect.forkChild(peer.rpc.request("account/read", {}));
        yield* until("wrote the request", () => peer.writes.length === 1);

        peer.answer("codex: warning: this is not a frame");
        yield* until("warned about the line", () => peer.warnings.length === 1);
        // One bad line must not take the socket down: the answer after it lands.
        peer.answer(
          JSON.stringify({ id: frameOf(peer.writes[0]!)["id"], result: { account: null } }),
        );
        expect(yield* Fiber.join(asked)).toEqual({ account: null });
        yield* Fiber.interrupt(pumping);
      }),
    );

    expect(peer.warnings).toHaveLength(1);
  });

  it("gives up on a request nothing ever answers, rather than waiting for ever", async () => {
    const peer = peering();

    const failure = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pumping = yield* Effect.forkChild(peer.rpc.pump);
          // Codex drops a method it does not know without a reply, so a request
          // with no bound would leak a pending entry on every call.
          const asked = yield* Effect.forkChild(Effect.flip(peer.rpc.request("nope/nothing", {})));
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(RPC_DEADLINE);
          const error = yield* Fiber.join(asked);
          yield* Fiber.interrupt(pumping);
          return error;
        }),
        TestClock.layer(),
      ),
    );

    expect(String(JSON.stringify(failure))).toContain("nope/nothing");
  });
});
