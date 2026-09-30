import { beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { makeRunnerIdentityLayer, RunnerIdentity } from "./runner-identity";
import {
  buildHttpAnswer,
  type FakeHttpServer,
  type HttpAnswer,
  nodeFetchWithoutRedirects,
  startFakeHttpServer,
} from "./testing";

const JSON_HEADERS = { "content-type": "application/json" };

let server: FakeHttpServer;
/** Each request the fake runner received, in order. */
let requests: Array<IncomingMessage>;
/** The fake runner's answer; a test sets it before the probe runs. */
let answer: HttpAnswer;

beforeEach(async () => {
  requests = [];
  answer = buildHttpAnswer(200, JSON_HEADERS, JSON.stringify({ runnerId: "runner-1" }));
  server = await startFakeHttpServer((request, response) => {
    requests.push(request);
    answer(response, request);
  });
  return server.close;
});

/** Runs the probe against `port` with the layer built on Node's `fetch`. */
const readRunnerId = (port: number) =>
  RunnerIdentity.use((identity) => identity.read(port)).pipe(
    Effect.provide(makeRunnerIdentityLayer(nodeFetchWithoutRedirects)),
  );

describe("RunnerIdentity.read", () => {
  it("sends GET /identity to 127.0.0.1 at the port and returns the runner id", async () => {
    expect(await Effect.runPromise(readRunnerId(server.port))).toBe("runner-1");
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/identity" },
    ]);
  });

  it.each<[string, HttpAnswer]>([
    ["a 404", buildHttpAnswer(404, JSON_HEADERS, JSON.stringify({ runnerId: "runner-1" }))],
    ["a redirect, which it does not follow", buildHttpAnswer(302, { location: "/elsewhere" })],
    ["a body that is not JSON", buildHttpAnswer(200, {}, "<html>not a runner</html>")],
    [
      "a body with no runner id",
      buildHttpAnswer(200, JSON_HEADERS, JSON.stringify({ id: "runner-1" })),
    ],
    [
      "a body longer than 64 KiB",
      buildHttpAnswer(
        200,
        JSON_HEADERS,
        JSON.stringify({ runnerId: "runner-1", padding: "x".repeat(64 * 1024) }),
      ),
    ],
  ])("returns null for %s", async (_case, answerForCase) => {
    answer = answerForCase;
    expect(await Effect.runPromise(readRunnerId(server.port))).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("returns null when nothing listens at the port", async () => {
    await server.close();
    expect(await Effect.runPromise(readRunnerId(server.port))).toBeNull();
  });

  it("returns null when the port does not answer within 1 second", async () => {
    let receiveRequest: () => void = () => {};
    const received = new Promise<void>((resolve) => (receiveRequest = resolve));
    answer = () => receiveRequest();
    const runnerId = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(readRunnerId(server.port));
        yield* Effect.promise(() => received);
        yield* TestClock.adjust("999 millis");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(runnerId).toBeNull();
  });
});
