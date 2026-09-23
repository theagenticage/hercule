/**
 * The runner socket. A runner is its own HTTP client, so unlike a browser it
 * can send a credential with the handshake. The credential is checked before
 * the upgrade, and is accepted nowhere else in Hercule.
 *
 * The controller proves its identity too: `greet` signs the runner's nonce
 * together with the runner's id. `encodeChallengeBytes` in `@hercule/protocol`
 * explains why both are signed.
 *
 * Liveness uses a protocol frame, never a WebSocket control frame: Bun answers
 * a control ping inside the runtime, which would only prove the machine is up,
 * not the runner process.
 *
 * The receive loop is awaited inline in the handler. Forking it before
 * returning the response would end it with the request scope, and the server
 * would receive nothing.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/unstable/socket/Socket";
import { createInternalError, createUnauthenticatedError } from "@hercule/contract";
import {
  ControllerToRunner,
  GOING_AWAY_CLOSE_CODE,
  PeerVersion,
  PROTOCOL_VERSION,
  RunnerFactsRequest,
  RunnerToController,
  encodeChallengeBytes,
  type ControllerHello,
  type RunnerHello,
} from "@hercule/protocol";
import { readBearerToken } from "../http/bearer";
import { buildErrorResponse } from "../http/envelope";
import { ControllerIdentity } from "../identity";
import { mintConnection, RunnerConnections, type Connection, type Departure } from "./connections";

const RUNNER_SOCKET_PATH = "/api/v1/runners/socket";

export const RUNNER_PING_INTERVAL: Duration.Duration = Duration.seconds(15);

/** Four missed intervals: one lost pong is a hiccup, four in a row means the runner is gone. */
export const RUNNER_SILENCE_LIMIT: Duration.Duration = Duration.seconds(60);

/** The ping interval and silence limit. Tests pass shorter values they can wait for. */
export interface RunnerPings {
  readonly interval: Duration.Duration;
  readonly silence: Duration.Duration;
}

export const RunnerPingSchedule = Context.Reference<RunnerPings>(
  "hercule/controller/runners/RunnerPingSchedule",
  {
    defaultValue: (): RunnerPings => ({
      interval: RUNNER_PING_INTERVAL,
      silence: RUNNER_SILENCE_LIMIT,
    }),
  },
);

const NO_CREDENTIAL = "the runner socket needs a runner's credential";

/**
 * A retired runner is told so, because its operator can act on it by joining
 * the runner again. Every other rejected credential gets the same message,
 * because telling apart a credential never created and one from another
 * controller would help someone probing for valid credentials.
 */
const UNKNOWN_CREDENTIAL = "unknown credential";

const RETIRED = "this runner was retired; run `hercule runner join` to join the fleet again";

/** Empty in v1: capability negotiation exists, but there is nothing to negotiate yet. */
const CAPABILITIES: ReadonlyArray<string> = [];

const UNREADABLE = "that is not a message this controller can read";
const WRONG_VERSION =
  `this controller speaks runner protocol version ${String(PROTOCOL_VERSION)}; ` +
  "update the runner to a build that matches the controller";
const GREETED_ALREADY = "this connection has already said hello";

/** The RFC 6455 protocol error close code. The other close codes used here are defined in the protocol package. */
const PROTOCOL_ERROR = 1002;

const SILENT = "this runner stopped answering";

const decodeFrame = Schema.decodeUnknownEffect(RunnerToController);
const decodePeerVersion = Schema.decodeUnknownEffect(PeerVersion);
const encodeFrame = Schema.encodeUnknownSync(ControllerToRunner);

const encodeFrameText = (message: typeof ControllerToRunner.Type): string =>
  JSON.stringify(encodeFrame(message));

const FACTS_REQUEST = encodeFrameText({ _tag: "factsRequest" } satisfies RunnerFactsRequest);

/** Returns the capabilities both sides offer, which are the only ones either may use. */
const negotiateCapabilities = (theirs: ReadonlyArray<string>): ReadonlyArray<string> =>
  CAPABILITIES.filter((capability) => theirs.includes(capability));

/**
 * Serves one runner connection until it closes: answers the hello, handles
 * every frame, sends pings, and records the runner as gone at the end.
 *
 * `mine` identifies this connection, so what it writes as it closes is dropped
 * if the runner has already connected again. `departure` stays `unreachable`
 * unless a `goodbye` frame marks a planned shutdown.
 */
const holdConnection = (runnerId: string, socket: Socket.Socket) =>
  Effect.gen(function* () {
    const connections = yield* RunnerConnections;
    const identity = yield* ControllerIdentity;
    const pings = yield* RunnerPingSchedule;
    const write = yield* socket.writer;

    const mine: Connection = mintConnection();
    let greeted = false;
    let departure: Departure = "unreachable";
    let lastHeard = yield* Clock.currentTimeMillis;

    /** Resolves with the close event the service asked this connection to close with. */
    const asked = Deferred.makeUnsafe<Socket.CloseEvent>();

    const closeWithProtocolError = (reason: string) =>
      write(new Socket.CloseEvent(PROTOCOL_ERROR, reason));

    const greet = (hello: RunnerHello) =>
      Effect.gen(function* () {
        const controller = yield* identity.read;
        if (Option.isNone(controller)) {
          // The boot creates the identity before the server starts, so a
          // missing identity is a bug, not a state to handle.
          return yield* Effect.die("the controller has no identity row");
        }
        const signature = yield* identity.sign(encodeChallengeBytes(runnerId, hello.nonce));
        const answer: ControllerHello = {
          _tag: "controllerHello",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          identityId: controller.value.id,
          publicKey: Buffer.from(controller.value.publicKey).toString("base64"),
          nonce: hello.nonce,
          signature: Buffer.from(signature).toString("base64"),
        };
        // Before the hello is answered, so a runner that receives the answer
        // already reads as online in the fleet.
        yield* connections.greeted(
          runnerId,
          mine,
          {
            close: (code, reason) => {
              Deferred.doneUnsafe(asked, Exit.succeed(new Socket.CloseEvent(code, reason)));
            },
            // A failed write means the connection is closing. The operation
            // waiting for the answer then fails when its deadline passes.
            askForFacts: Effect.ignore(write(FACTS_REQUEST)),
            ask: (request) => Effect.ignore(write(encodeFrameText(request))),
          },
          {
            binaryVersion: hello.binaryVersion,
            protocolVersion: hello.protocolVersion,
            negotiatedCapabilities: negotiateCapabilities(hello.capabilities),
            facts: hello.facts,
          },
        );
        greeted = true;
        yield* write(encodeFrameText(answer));
        // After the answer, because the runner drops every frame that arrives
        // before the controller's hello. A probe sweep announced earlier could
        // have its first probe dropped.
        yield* connections.arrived(runnerId);
      });

    const handleFrame = (raw: string) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.option(
          Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }),
        );
        if (Option.isNone(parsed)) return yield* closeWithProtocolError(UNREADABLE);
        // The version is read before the frame is decoded, because a newer
        // runner's hello does not decode here. It would otherwise be reported
        // as unreadable rather than as a version mismatch.
        const version = yield* Effect.option(decodePeerVersion(parsed.value));
        if (Option.isSome(version) && version.value.protocolVersion !== PROTOCOL_VERSION) {
          return yield* closeWithProtocolError(WRONG_VERSION);
        }
        const frame = yield* Effect.option(decodeFrame(parsed.value));
        if (Option.isNone(frame)) return yield* closeWithProtocolError(UNREADABLE);
        const message = frame.value;
        switch (message._tag) {
          case "runnerHello":
            // Without this check, a runner could make the controller sign and
            // write a reply for every frame it sends.
            if (greeted) return yield* closeWithProtocolError(GREETED_ALREADY);
            return yield* greet(message);
          case "pong":
            // The only frame that counts as a sign of life, and only after the
            // hello. Otherwise anything holding a credential could keep the
            // runner's "last seen" time current.
            if (!greeted) return;
            lastHeard = yield* Clock.currentTimeMillis;
            return yield* connections.answered(runnerId);
          case "factsReport":
            // Until the hello arrives, this connection has only shown that
            // somebody holds a credential.
            if (!greeted) return;
            return yield* connections.reportedFacts(runnerId, mine, message.facts);
          case "watermarkReport":
            if (!greeted) return;
            return yield* connections.reportedWatermark(runnerId, mine, message.watermark);
          case "probeReport":
          case "installResult":
          case "loginUrl":
          case "loginFailed":
          case "loginResult":
          case "sessionInputResult":
            if (!greeted) return;
            return yield* connections.reportedAnswer(runnerId, mine, message);
          case "workspaceReport":
            // Published rather than handled, like a session event: the
            // workspaces domain interprets the report, not the socket.
            if (!greeted) return;
            return yield* connections.reportedWorkspace(runnerId, mine, message);
          case "credentialRequest":
            if (!greeted) return;
            return yield* connections.requestedCredential(runnerId, mine, message);
          case "sessionEvent":
          case "sessionsReport":
            // Passed on rather than handled: the sessions domain interprets
            // session events, and this file only deals with the socket.
            if (!greeted) return;
            return yield* connections.reportedSession(runnerId, mine, message);
          case "goodbye":
            departure = "offline";
            return;
        }
        // Every frame the protocol declares is handled above. The type check
        // makes a new frame type fail to compile instead of being dropped
        // silently.
        return message satisfies never;
      });

    // The transport forks a fiber per frame, so without this lock two frames
    // arriving together would update the same variables at once.
    const frames = yield* Semaphore.make(1);
    const receiveFrame = (raw: string) => frames.withPermits(1)(handleFrame(raw));

    /**
     * Sends a ping every interval, and closes the connection when the runner
     * has been silent past the limit. It is raced against the receive loop, so
     * neither outlives the other.
     */
    const ask = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(pings.interval);
        if ((yield* Clock.currentTimeMillis) - lastHeard > Duration.toMillis(pings.silence)) {
          return yield* write(new Socket.CloseEvent(GOING_AWAY_CLOSE_CODE, SILENT));
        }
        yield* write(encodeFrameText({ _tag: "ping" }));
      }
    });

    const closeWhenAsked = Effect.flatMap(Deferred.await(asked), write);

    /**
     * Records that the connection ended. It runs as a finalizer, because a
     * runner that hangs up aborts the request, and an aborted request
     * interrupts the fiber serving it. Without the finalizer, the most
     * important write, moving the runner off `online`, would never happen.
     */
    const leave = Effect.suspend(() => connections.ended(runnerId, mine, departure));

    yield* Effect.ensuring(
      Effect.race(
        Effect.tapCause(socket.runString(receiveFrame), (cause) =>
          Effect.logError("A runner's connection ended in an error", cause),
        ).pipe(Effect.ignore),
        Effect.race(ask, closeWhenAsked),
      ),
      Effect.tapCause(leave, (cause) =>
        Effect.logError("A runner's row could not be moved off online", cause),
      ).pipe(Effect.ignore),
    );
  });

/**
 * The route for the runner socket. The credential is checked before the
 * upgrade, so a rejected credential gets an ordinary `401` error response.
 */
export const RunnerSocketRouteLayer = HttpRouter.add("GET", RUNNER_SOCKET_PATH, (request) =>
  Effect.gen(function* () {
    const connections = yield* RunnerConnections;
    const credential = readBearerToken(request);
    if (credential === undefined)
      return buildErrorResponse(createUnauthenticatedError(NO_CREDENTIAL));
    // A database error is not a rejected credential. A runner told
    // `unauthenticated` would stop using a credential that is still valid.
    const admitted = yield* Effect.catch(connections.admits(credential), (error) =>
      Effect.as(Effect.logError("A runner's credential could not be resolved", error), undefined),
    );
    if (admitted === undefined)
      return buildErrorResponse(createInternalError("something went wrong"));
    if (Option.isNone(admitted)) {
      const retired = yield* Effect.catch(connections.wasRetired(credential), (error) =>
        Effect.as(Effect.logError("A rejected credential could not be looked up", error), false),
      );
      return buildErrorResponse(createUnauthenticatedError(retired ? RETIRED : UNKNOWN_CREDENTIAL));
    }

    const socket = yield* request.upgrade;
    // After the upgrade there is no HTTP response left to send a status on.
    yield* holdConnection(admitted.value, socket);
    return HttpServerResponse.empty();
  }).pipe(Effect.withSpan("runner.socket")),
);
