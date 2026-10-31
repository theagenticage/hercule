/**
 * Tests for the newline-delimited JSON-RPC codec, run over in-memory line
 * streams: what it writes, how it routes incoming frames, and how it handles
 * an app-server that replies late, with bad lines, or not at all.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { RPC_DEADLINE, makeRpc, type Rpc } from "./rpc";
import { createLines } from "./testing";

interface Peer {
  readonly rpc: Rpc;
  /** Everything written to the peer's stdin, unchanged. */
  readonly writes: Array<string>;
  readonly answer: (line: string) => void;
  readonly warnings: Array<string>;
  readonly serverRequests: Array<{ readonly id: string | number; readonly method: string }>;
  readonly notifications: Array<{ readonly method: string; readonly params: unknown }>;
}

const createPeer = (): Peer => {
  const stdout = createLines();
  const writes: Array<string> = [];
  const warnings: Array<string> = [];
  const serverRequests: Array<{ readonly id: string | number; readonly method: string }> = [];
  const notifications: Array<{ readonly method: string; readonly params: unknown }> = [];
  const rpc = makeRpc(
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

/** Waits until `ready()` is true, or fails after `WAIT_MS` with `what` in the message. */
const waitUntil = (what: string, ready: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + WAIT_MS;
    while (!ready() && Date.now() < deadline) yield* Effect.sleep(1);
    expect(ready(), `the codec never ${what}`).toBe(true);
  });

const parseFrame = (written: string): Record<string, unknown> =>
  JSON.parse(written) as Record<string, unknown>;

/** Creates a peer whose stdin has closed, so every write to it throws. */
const createDeafPeer = (): Peer => {
  const stdout = createLines();
  const warnings: Array<string> = [];
  const rpc = makeRpc(
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
  it("warns once and never throws", () => {
    const peer = createDeafPeer();

    // A throw from a reply would crash the code replying to the request, and
    // the turn would hang anyway.
    expect(() => peer.rpc.answer(1, { result: {} })).not.toThrow();
    expect(() => peer.rpc.notify("initialized")).not.toThrow();
    expect(() => peer.rpc.answer(2, { error: { message: "no" } })).not.toThrow();

    // Only once: after the pipe closes, every write fails for the same reason.
    expect(peer.warnings).toHaveLength(1);
    expect(peer.warnings[0]).toContain("EPIPE");
  });

  it("fails the request it could not send", async () => {
    const peer = createDeafPeer();

    const failure = await Effect.runPromise(Effect.flip(peer.rpc.request("initialize", {})));

    expect(failure.message).toContain("EPIPE");
  });
});

describe("what the codec writes", () => {
  it("writes one line per request, with no jsonrpc key", async () => {
    const peer = createPeer();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        const asked = yield* Effect.forkChild(
          peer.rpc.request("initialize", { clientInfo: { name: "hercule" } }),
        );
        yield* waitUntil("wrote the request", () => peer.writes.length === 1);

        const written = peer.writes[0]!;
        // Newline-delimited: the peer reads exactly one frame per line.
        expect(written.endsWith("\n")).toBe(true);
        expect(written.trimEnd()).not.toContain("\n");
        const frame = parseFrame(written);
        expect(typeof frame["id"]).toBe("number");
        expect(frame["method"]).toBe("initialize");
        expect(frame["params"]).toEqual({ clientInfo: { name: "hercule" } });
        // Codex leaves out `jsonrpc` in both directions, and accepts frames without it.
        expect(Object.keys(frame)).not.toContain("jsonrpc");

        peer.answer(JSON.stringify({ id: frame["id"], result: { userAgent: "hercule/0.154.0" } }));
        const answered = yield* Fiber.join(asked);
        expect(answered).toEqual({ userAgent: "hercule/0.154.0" });
        yield* Fiber.interrupt(pumping);
      }),
    );
  });

  it("gives each request its own id, so replies to two requests in flight are not mixed up", async () => {
    const peer = createPeer();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        const first = yield* Effect.forkChild(peer.rpc.request("account/read", {}));
        const second = yield* Effect.forkChild(peer.rpc.request("model/list", {}));
        yield* waitUntil("wrote both requests", () => peer.writes.length === 2);

        const ids = peer.writes.map((written) => parseFrame(written)["id"]);
        expect(new Set(ids).size).toBe(2);

        // Replied to out of order, which is what the ids are for.
        peer.answer(JSON.stringify({ id: ids[1], result: { data: [] } }));
        peer.answer(JSON.stringify({ id: ids[0], result: { account: null } }));
        expect(yield* Fiber.join(first)).toEqual({ account: null });
        expect(yield* Fiber.join(second)).toEqual({ data: [] });
        yield* Fiber.interrupt(pumping);
      }),
    );
  });
});

describe("how the codec routes incoming frames", () => {
  it("fails the request an error reply is for, with the error's code and message", async () => {
    const peer = createPeer();

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        const asked = yield* Effect.forkChild(
          Effect.flip(peer.rpc.request("turn/start", { threadId: "t-1" })),
        );
        yield* waitUntil("wrote the request", () => peer.writes.length === 1);

        peer.answer(
          JSON.stringify({
            error: { code: -32600, message: "thread not found: 00000000-0000-0000-0000-0" },
            id: parseFrame(peer.writes[0]!)["id"],
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
    const peer = createPeer();

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
        yield* waitUntil("delivered the server request", () => peer.serverRequests.length === 1);
        yield* Fiber.interrupt(pumping);
      }),
    );

    expect(peer.serverRequests[0]).toMatchObject({
      id: 7,
      method: "item/commandExecution/requestApproval",
    });
    // A request treated as a notification would get no reply and hang the turn forever.
    expect(peer.notifications).toEqual([]);
  });

  it("delivers a frame with a method and no id as a notification", async () => {
    const peer = createPeer();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        peer.answer(
          JSON.stringify({
            method: "remoteControl/status/changed",
            params: { status: "disabled" },
          }),
        );
        yield* waitUntil("delivered the notification", () => peer.notifications.length === 1);
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

describe("a peer that sends bad lines or never replies", () => {
  it("warns once about a line that is not JSON, and keeps reading the stream", async () => {
    const peer = createPeer();

    await Effect.runPromise(
      Effect.gen(function* () {
        const pumping = yield* Effect.forkChild(peer.rpc.pump);
        const asked = yield* Effect.forkChild(peer.rpc.request("account/read", {}));
        yield* waitUntil("wrote the request", () => peer.writes.length === 1);

        peer.answer("codex: warning: this is not a frame");
        yield* waitUntil("warned about the line", () => peer.warnings.length === 1);
        // One bad line must not close the connection: the reply after it still arrives.
        peer.answer(
          JSON.stringify({ id: parseFrame(peer.writes[0]!)["id"], result: { account: null } }),
        );
        expect(yield* Fiber.join(asked)).toEqual({ account: null });
        yield* Fiber.interrupt(pumping);
      }),
    );

    expect(peer.warnings).toHaveLength(1);
  });

  it("fails a request that never gets a reply once the timeout passes, and names the method", async () => {
    const peer = createPeer();

    const failure = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pumping = yield* Effect.forkChild(peer.rpc.pump);
          // Codex never replies to a method it does not know, so a request
          // with no timeout would leak a pending entry on every call.
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
