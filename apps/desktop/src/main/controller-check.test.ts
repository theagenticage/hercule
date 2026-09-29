import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import type { Method } from "@hercule/contract";
import { checkController, type ControllerCheckOutcome } from "./controller-check";
import type { FetchWithoutRedirects } from "./fetch-without-redirects";

/**
 * Node's `fetch`, told not to follow redirects, in place of the app's, which
 * sends through Chromium's network stack and which only Electron can run.
 */
const fetchWithoutRedirects: FetchWithoutRedirects = (url, init) =>
  fetch(url, { ...init, redirect: "manual" });

/** How the fake controller answers one request, `request`. */
type Answer = (response: ServerResponse, request: IncomingMessage) => void;

/** The headers of an answer; a header with several values is sent once per value. */
type AnswerHeaders = Record<string, string | Array<string>>;

/** Returns the answer with `status`, `headers` and `body`. */
const reply =
  (status: number, headers: AnswerHeaders = {}, body = ""): Answer =>
  (response) =>
    response.writeHead(status, headers).end(body);

const ALLOWS_APP = { "access-control-allow-origin": "app://hercule" };

/** Returns an answer to the setup read with `body`, a JSON setup state or not. */
const setupRead = (body: string, headers: AnswerHeaders = ALLOWS_APP): Answer =>
  reply(200, { "content-type": "application/json", ...headers }, body);

const SET_UP = JSON.stringify({ complete: true });
const NOT_SET_UP = JSON.stringify({ complete: false });

/** The headers of the controller's answer to the preflight, as apps/controller sends them. */
const PREFLIGHT_HEADERS = {
  ...ALLOWS_APP,
  "access-control-allow-methods": "DELETE, GET, PATCH, POST, PUT",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "7200",
};

/** The controller's answer to the preflight. */
const PREFLIGHT = reply(204, PREFLIGHT_HEADERS);

/** Every method the public API uses, sorted: the check sends a preflight for each. */
const API_METHODS: ReadonlyArray<Method> = ["DELETE", "GET", "PATCH", "POST", "PUT"];

/** The outcome when the preflight is refused for every method. */
const REFUSED_FOR_EVERY_METHOD: ControllerCheckOutcome = {
  _tag: "PreflightRefused",
  methods: API_METHODS,
};

/** Returns a setup state of exactly `length` bytes, padded with a key the schema ignores. */
const paddedSetUp = (length: number) => {
  const empty = JSON.stringify({ complete: true, padding: "" });
  return JSON.stringify({ complete: true, padding: "x".repeat(length - empty.length) });
};

let server: Server;
let origin: string;
/** Each request the fake controller received, in order. */
let requests: Array<IncomingMessage>;
/** The fake controller's answer to each method; a test sets them before the check runs. */
let answers: { GET: Answer; OPTIONS: Answer };

beforeEach(async () => {
  requests = [];
  answers = { GET: setupRead(SET_UP), OPTIONS: PREFLIGHT };
  server = createServer((request, response) => {
    requests.push(request);
    answers[request.method as keyof typeof answers](response, request);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("checkController", () => {
  it("reads the setup state, then sends a preflight for each method the API uses, all with the desktop app's origin", async () => {
    await Effect.runPromise(checkController(origin, fetchWithoutRedirects));
    const [setupReadRequest, ...preflights] = requests.map(({ method, url, headers }) => ({
      method,
      url,
      origin: headers.origin,
      requestMethod: headers["access-control-request-method"],
      requestHeaders: headers["access-control-request-headers"],
    }));
    expect(setupReadRequest).toEqual({
      method: "GET",
      url: "/api/v1/setup",
      origin: "app://hercule",
    });
    // The preflights are sent at once, so they arrive in any order.
    expect(preflights.sort((a, b) => a.requestMethod!.localeCompare(b.requestMethod!))).toEqual(
      API_METHODS.map((requestMethod) => ({
        method: "OPTIONS",
        url: "/api/v1/setup",
        origin: "app://hercule",
        requestMethod,
        requestHeaders: "authorization, content-type",
      })),
    );
  });

  it.each<[string, Answer, ControllerCheckOutcome]>([
    ["a set-up controller that accepts the app", setupRead(SET_UP), { _tag: "Ready" }],
    ["a controller that is not set up", setupRead(NOT_SET_UP), { _tag: "SetupIncomplete" }],
    [
      "a controller that does not accept the app",
      setupRead(SET_UP, {}),
      { _tag: "OriginNotAllowed" },
    ],
    [
      "a controller that accepts every origin, which counts because the page sends no credentials",
      setupRead(SET_UP, { "access-control-allow-origin": "*" }),
      { _tag: "Ready" },
    ],
    [
      "a controller that accepts another origin",
      setupRead(SET_UP, { "access-control-allow-origin": "https://hercule.example" }),
      { _tag: "OriginNotAllowed" },
    ],
    [
      "an answer that sends the allowed origin twice, as a proxy that adds its own does",
      setupRead(SET_UP, { "access-control-allow-origin": ["app://hercule", "*"] }),
      { _tag: "OriginNotAllowed" },
    ],
    [
      "a controller that neither accepts the app nor is set up",
      setupRead(NOT_SET_UP, {}),
      { _tag: "OriginNotAllowed" },
    ],
    [
      "an error status, even with the app accepted",
      reply(500, ALLOWS_APP, SET_UP),
      { _tag: "NotController" },
    ],
    [
      "a status outside 200-599, which a standard Response refuses",
      reply(999, ALLOWS_APP, SET_UP),
      { _tag: "NotController" },
    ],
    [
      "a redirect of the same path to another origin",
      reply(301, { location: "https://hercule.example.com/api/v1/setup" }),
      { _tag: "Redirected", targetOrigin: "https://hercule.example.com" },
    ],
    [
      "a redirect with a location relative to the scheme",
      reply(308, { location: "//hercule.example.com:8443/api/v1/setup" }),
      { _tag: "Redirected", targetOrigin: "http://hercule.example.com:8443" },
    ],
    [
      "a redirect to another path, such as a login page",
      reply(302, { location: "https://sso.example.com/login?next=/api/v1/setup" }),
      { _tag: "NotController" },
    ],
    [
      "a redirect that adds a query",
      reply(307, { location: "https://hercule.example.com/api/v1/setup?from=http" }),
      { _tag: "NotController" },
    ],
    [
      "a redirect to the same URL",
      reply(301, { location: "/api/v1/setup" }),
      { _tag: "NotController" },
    ],
    ["a redirect without a location", reply(302), { _tag: "NotController" }],
    ["a body that is not JSON", setupRead("<html></html>"), { _tag: "NotController" }],
    [
      "JSON that is not a setup state, even without the app accepted",
      setupRead(JSON.stringify({ complete: "yes" }), {}),
      { _tag: "NotController" },
    ],
    ["a body of exactly 64 kB", setupRead(paddedSetUp(64 * 1024)), { _tag: "Ready" }],
    [
      "a body over 64 kB, even when it is a setup state",
      setupRead(paddedSetUp(64 * 1024 + 1)),
      { _tag: "NotController" },
    ],
  ])("returns the outcome for %s", async (_case, answer, outcome) => {
    answers.GET = answer;
    expect(await Effect.runPromise(checkController(origin, fetchWithoutRedirects))).toEqual(
      outcome,
    );
  });

  it("follows no redirect and sends no preflight after one", async () => {
    // A redirect to the same URL: followed, it would reach this server again.
    answers.GET = reply(301, { location: "/api/v1/setup" });
    await Effect.runPromise(checkController(origin, fetchWithoutRedirects));
    expect(requests.map(({ method, url }) => [method, url])).toEqual([["GET", "/api/v1/setup"]]);
  });

  it.each<[string, Answer, ControllerCheckOutcome]>([
    [
      "allows any method and names the headers in capitals",
      reply(204, {
        ...ALLOWS_APP,
        "access-control-allow-methods": "*",
        "access-control-allow-headers": "Authorization, *",
      }),
      { _tag: "Ready" },
    ],
    ["is refused with 404", reply(404), REFUSED_FOR_EVERY_METHOD],
    [
      "is refused with 405, the headers allowed",
      reply(405, PREFLIGHT_HEADERS),
      REFUSED_FOR_EVERY_METHOD,
    ],
    [
      "is redirected",
      reply(301, { ...PREFLIGHT_HEADERS, location: "https://hercule.example.com/api/v1/setup" }),
      REFUSED_FOR_EVERY_METHOD,
    ],
    [
      "allows every origin with *, which counts because the page sends no credentials",
      reply(204, { ...PREFLIGHT_HEADERS, "access-control-allow-origin": "*" }),
      { _tag: "Ready" },
    ],
    [
      "does not list GET and POST, which CORS always allows",
      reply(204, { ...PREFLIGHT_HEADERS, "access-control-allow-methods": "DELETE, PATCH, PUT" }),
      { _tag: "Ready" },
    ],
    [
      "allows the method each preflight asks for, as a server that repeats it does",
      (response, request) =>
        reply(204, {
          ...PREFLIGHT_HEADERS,
          "access-control-allow-methods": request.headers["access-control-request-method"] ?? "",
        })(response, request),
      { _tag: "Ready" },
    ],
    [
      "allows only GET and POST",
      reply(204, { ...PREFLIGHT_HEADERS, "access-control-allow-methods": "GET, POST" }),
      { _tag: "PreflightRefused", methods: ["DELETE", "PATCH", "PUT"] },
    ],
    [
      "has no access-control-allow-methods header",
      reply(204, { ...ALLOWS_APP, "access-control-allow-headers": "authorization, content-type" }),
      { _tag: "PreflightRefused", methods: ["DELETE", "PATCH", "PUT"] },
    ],
    [
      "allows patch in lowercase, which Chromium does not read as PATCH",
      reply(204, {
        ...PREFLIGHT_HEADERS,
        "access-control-allow-methods": "DELETE, GET, patch, POST, PUT",
      }),
      { _tag: "PreflightRefused", methods: ["PATCH"] },
    ],
    [
      "allows another origin",
      reply(204, {
        ...PREFLIGHT_HEADERS,
        "access-control-allow-origin": "https://hercule.example",
      }),
      REFUSED_FOR_EVERY_METHOD,
    ],
    [
      "sends the allowed origin twice",
      reply(204, { ...PREFLIGHT_HEADERS, "access-control-allow-origin": ["app://hercule", "*"] }),
      REFUSED_FOR_EVERY_METHOD,
    ],
    [
      "does not name the authorization header, which * does not cover",
      reply(204, { ...PREFLIGHT_HEADERS, "access-control-allow-headers": "*" }),
      REFUSED_FOR_EVERY_METHOD,
    ],
    [
      "does not allow the content-type header",
      reply(204, { ...PREFLIGHT_HEADERS, "access-control-allow-headers": "authorization" }),
      REFUSED_FOR_EVERY_METHOD,
    ],
    [
      "closes the connection without an answer",
      (response) => response.socket?.destroy(),
      REFUSED_FOR_EVERY_METHOD,
    ],
  ])("returns the outcome when the preflight %s", async (_case, answer, outcome) => {
    answers.OPTIONS = answer;
    expect(await Effect.runPromise(checkController(origin, fetchWithoutRedirects))).toEqual(
      outcome,
    );
  });

  it("returns Unreachable when nothing listens at the origin", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await Effect.runPromise(checkController(origin, fetchWithoutRedirects))).toEqual({
      _tag: "Unreachable",
    });
    // afterEach closes the server again, so it must be listening.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  it.each(["GET", "OPTIONS"] as const)(
    "returns Unreachable when the %s request is not answered within 5 seconds of the start",
    async (method) => {
      let receiveRequest: () => void = () => {};
      const received = new Promise<void>((resolve) => (receiveRequest = resolve));
      answers[method] = () => receiveRequest();
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(checkController(origin, fetchWithoutRedirects));
          yield* Effect.promise(() => received);
          yield* TestClock.adjust("4999 millis");
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 millis");
          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer())),
      );
      expect(outcome).toEqual({ _tag: "Unreachable" });
    },
  );
});
