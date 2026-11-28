/**
 * Tests the listener's drain on a real Bun listener, with a real WebSocket
 * and real HTTP requests.
 *
 * The routes are small stand-ins that wait on a gate the test controls, so
 * each test can hold a request or a socket open at the exact moment it needs
 * to. What is under test is the drain's contract (`./drain.ts`): which
 * requests it waits for, which it refuses, and what a socket sees.
 */
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { GOING_AWAY_CLOSE_CODE } from "@hercule/protocol";
import { ListenerDrain, ListenerDrainLayer, buildStoppingResponse } from "./drain";
import { listenerOptions } from "./server";

/** How long a test waits to be sure something that should stay pending is still pending. */
const STILL_PENDING_MS = 150;

/** How long a socket's route takes to clean up after the socket closed. */
const SLOW_CLEANUP_MS = 100;

/** The gates and records the stand-in routes share with the test. */
interface Rig {
  /** What the routes did, in order. */
  readonly log: Array<string>;
  /** Opened by the test to let the request at `/slow` answer. */
  readonly releaseSlow: Deferred.Deferred<void>;
  /** Opened by the test to let the response at `/stream` send its second chunk. */
  readonly releaseStream: Deferred.Deferred<void>;
  /** Opened by the route at `/late-ws` when a request has reached it. */
  readonly lateReached: Deferred.Deferred<void>;
  /** Opened by the test to let the route at `/late-ws` try to upgrade. */
  readonly releaseLate: Deferred.Deferred<void>;
}

const encoder = new TextEncoder();

const buildRoutes = (rig: Rig) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/slow",
      Effect.gen(function* () {
        yield* Deferred.await(rig.releaseSlow);
        return HttpServerResponse.text("slow answer");
      }),
    ),
    // The handler returns at once, with the response's body still to come: the
    // second chunk is only produced when the test lets it.
    HttpRouter.add(
      "GET",
      "/stream",
      Effect.succeed(
        HttpServerResponse.stream(
          Stream.concat(
            Stream.make(encoder.encode("first;")),
            Stream.fromEffect(Deferred.await(rig.releaseStream)).pipe(
              Stream.map(() => encoder.encode("second")),
            ),
          ),
          { contentType: "text/plain" },
        ),
      ),
    ),
    // Holds the socket until the peer closes it, then takes a while to clean
    // up, as a runner's route does when it records that the runner left.
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const drain = yield* ListenerDrain;
        const socket = yield* drain.upgrade(request);
        yield* Effect.addFinalizer(() =>
          Effect.andThen(
            Effect.sleep(SLOW_CLEANUP_MS),
            Effect.sync(() => rig.log.push("route cleaned up")),
          ),
        );
        const { pull } = yield* socket.reader;
        yield* Effect.ignore(Effect.forever(pull));
        return HttpServerResponse.empty();
      }).pipe(Effect.catchTag("ListenerStopping", () => Effect.succeed(buildStoppingResponse()))),
    ),
    // A request that is admitted, then reaches its upgrade only when the test says.
    HttpRouter.add(
      "GET",
      "/late-ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const drain = yield* ListenerDrain;
        yield* Deferred.succeed(rig.lateReached, undefined);
        yield* Deferred.await(rig.releaseLate);
        yield* drain.upgrade(request);
        rig.log.push("late upgrade accepted");
        return HttpServerResponse.empty();
      }).pipe(Effect.catchTag("ListenerStopping", () => Effect.succeed(buildStoppingResponse()))),
    ),
  );

/** What a test gets: the listener's drain, the rig, and where to reach the listener. */
interface Listener {
  readonly drain: ListenerDrain["Service"];
  readonly rig: Rig;
  readonly port: number;
}

/** Runs `body` against a listener that serves the stand-in routes behind the drain. */
const withListener = (body: (listener: Listener) => Effect.Effect<void, unknown, never>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const drain = yield* ListenerDrain;
        const rig: Rig = {
          log: [],
          releaseSlow: Deferred.makeUnsafe<void>(),
          releaseStream: Deferred.makeUnsafe<void>(),
          lateReached: Deferred.makeUnsafe<void>(),
          releaseLate: Deferred.makeUnsafe<void>(),
        };
        const app = yield* HttpRouter.toHttpEffect(buildRoutes(rig));
        yield* HttpServer.serveEffect()(drain.track(app));
        const { address } = yield* HttpServer.HttpServer;
        if (address._tag === "UnixPathAddress") throw new Error("expected a TCP address");
        yield* body({ drain, rig, port: address.port });
      }),
    ).pipe(
      Effect.provide(ListenerDrainLayer),
      Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...listenerOptions })),
    ),
  );

/** Returns true when the fiber has not finished after `STILL_PENDING_MS`. */
const isStillWaiting = (fiber: Fiber.Fiber<unknown, unknown>) =>
  Effect.race(
    Effect.as(Fiber.await(fiber), false),
    Effect.as(Effect.sleep(STILL_PENDING_MS), true),
  );

/** Opens a WebSocket and resolves once it is open. */
const openWebSocket = (port: number) =>
  Effect.promise(
    () =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        socket.onopen = () => resolve(socket);
        socket.onerror = () => reject(new Error("the socket did not open"));
      }),
  );

/** Returns the code and reason a WebSocket is closed with. */
const readClose = (socket: WebSocket) =>
  new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  });

/**
 * Sends one raw HTTP request and returns the status and the body of the
 * answer. A WebSocket handshake is sent raw so the test sees the status the
 * server answered with, which a `WebSocket` client does not expose.
 */
const sendRaw = (port: number, path: string, upgrade: boolean) =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port }, () => {
          socket.write(
            `GET ${path} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: ${upgrade ? "Upgrade" : "close"}\r\n` +
              (upgrade
                ? "upgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                : "") +
              "\r\n",
          );
        });
        let received = "";
        socket.on("data", (chunk) => {
          received += chunk.toString();
          const split = received.indexOf("\r\n\r\n");
          if (split === -1) return;
          const status = Number(received.slice(0, received.indexOf("\r\n")).split(" ")[1]);
          const body = received.slice(split + 4);
          // The 503 body is one small JSON object, so it arrives with its headers.
          if (body.includes("}")) {
            socket.destroy();
            resolve({ status, body });
          }
        });
        socket.on("error", reject);
      }),
  );

describe("ListenerDrain", () => {
  it("closes an open socket with the going-away code, and returns after its route has ended", () =>
    withListener(({ drain, rig, port }) =>
      Effect.gen(function* () {
        const socket = yield* openWebSocket(port);
        const closed = readClose(socket);

        yield* drain.closeSockets;

        expect(rig.log).toEqual(["route cleaned up"]);
        expect(yield* Effect.promise(() => closed)).toEqual({
          code: GOING_AWAY_CLOSE_CODE,
          reason: "the controller is stopping",
        });
      }),
    ));

  it("lets a request in flight finish, and waits for it", () =>
    withListener(({ drain, rig, port }) =>
      Effect.gen(function* () {
        const answer = yield* Effect.forkChild(
          Effect.promise(async () => {
            const response = await fetch(`http://127.0.0.1:${port}/slow`);
            return { status: response.status, body: await response.text() };
          }),
        );
        // Wait until the request is in the handler, so it is counted.
        yield* Effect.sleep(STILL_PENDING_MS);

        const finishing = yield* Effect.forkChild(drain.finishRequests);
        expect(yield* isStillWaiting(finishing)).toBe(true);

        yield* Deferred.succeed(rig.releaseSlow, undefined);
        expect(yield* Fiber.join(answer)).toEqual({ status: 200, body: "slow answer" });
        yield* Fiber.join(finishing);
      }),
    ));

  it("counts a streamed response until its whole body has been sent", () =>
    withListener(({ drain, rig, port }) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/stream`));
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        const first = yield* Effect.promise(() => reader.read());
        expect(first.value).toBe("first;");

        // The handler returned long ago; only the body is still being sent.
        const finishing = yield* Effect.forkChild(drain.finishRequests);
        expect(yield* isStillWaiting(finishing)).toBe(true);

        yield* Deferred.succeed(rig.releaseStream, undefined);
        const second = yield* Effect.promise(() => reader.read());
        expect(second.value).toBe("second");
        yield* Fiber.join(finishing);
      }),
    ));

  it("refuses a request and an upgrade that arrive after the drain began, with a 503", () =>
    withListener(({ drain, port }) =>
      Effect.gen(function* () {
        yield* drain.finishRequests;

        for (const upgrade of [false, true]) {
          const refused = yield* sendRaw(port, "/ws", upgrade);
          expect(refused.status).toBe(503);
          expect(JSON.parse(refused.body)).toEqual({
            error: { code: "internal", message: "Hercule is stopping; try again once it is back." },
          });
        }
      }),
    ));

  it("refuses an upgrade that was admitted before the drain but upgrades after it", () =>
    withListener(({ drain, rig, port }) =>
      Effect.gen(function* () {
        const refused = yield* Effect.forkChild(sendRaw(port, "/late-ws", true));
        yield* Deferred.await(rig.lateReached);

        // A request that asks for a WebSocket is not counted, so this returns at once.
        yield* drain.finishRequests;
        yield* Deferred.succeed(rig.releaseLate, undefined);

        expect((yield* Fiber.join(refused)).status).toBe(503);
        expect(rig.log).toEqual([]);
      }),
    ));
});
