import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import type { FetchWithoutRedirects } from "./fetch-without-redirects";
import { makeRunnerIdentityLayer, RunnerIdentity } from "./runner-identity";

/**
 * Node's `fetch`, told not to follow redirects, in place of the app's, which
 * sends through Chromium's network stack and which only Electron can run.
 */
const fetchWithoutRedirects: FetchWithoutRedirects = (url, init) =>
  fetch(url, { ...init, redirect: "manual" });

/** How the fake runner answers one request. */
type Answer = (response: ServerResponse) => void;

/** Returns the answer with `status`, `headers` and `body`. */
const reply =
  (status: number, headers: Record<string, string>, body = ""): Answer =>
  (response) =>
    response.writeHead(status, headers).end(body);

const JSON_HEADERS = { "content-type": "application/json" };

let server: Server;
let port: number;
/** Each request the fake runner received, in order. */
let requests: Array<IncomingMessage>;
/** The fake runner's answer; a test sets it before the probe runs. */
let answer: Answer;

beforeEach(async () => {
  requests = [];
  answer = reply(200, JSON_HEADERS, JSON.stringify({ runnerId: "runner-1" }));
  server = createServer((request, response) => {
    requests.push(request);
    answer(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Runs the probe against `port` with the layer built on Node's `fetch`. */
const readRunnerId = (probedPort: number) =>
  RunnerIdentity.use((identity) => identity.read(probedPort)).pipe(
    Effect.provide(makeRunnerIdentityLayer(fetchWithoutRedirects)),
  );

describe("RunnerIdentity.read", () => {
  it("sends GET /identity to 127.0.0.1 at the port and returns the runner id", async () => {
    expect(await Effect.runPromise(readRunnerId(port))).toBe("runner-1");
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/identity" },
    ]);
  });

  it.each<[string, Answer]>([
    ["a 404", reply(404, JSON_HEADERS, JSON.stringify({ runnerId: "runner-1" }))],
    ["a redirect, which it does not follow", reply(302, { location: "/elsewhere" })],
    ["a body that is not JSON", reply(200, {}, "<html>not a runner</html>")],
    ["a body with no runner id", reply(200, JSON_HEADERS, JSON.stringify({ id: "runner-1" }))],
    [
      "a body longer than 64 KiB",
      reply(
        200,
        JSON_HEADERS,
        JSON.stringify({ runnerId: "runner-1", padding: "x".repeat(64 * 1024) }),
      ),
    ],
  ])("returns null for %s", async (_case, answerForCase) => {
    answer = answerForCase;
    expect(await Effect.runPromise(readRunnerId(port))).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("returns null when nothing listens at the port", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await Effect.runPromise(readRunnerId(port))).toBeNull();
    // afterEach closes the server again, so it must be listening.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  it("returns null when the port does not answer within 1 second", async () => {
    let receiveRequest: () => void = () => {};
    const received = new Promise<void>((resolve) => (receiveRequest = resolve));
    answer = () => receiveRequest();
    const runnerId = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(readRunnerId(port));
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
