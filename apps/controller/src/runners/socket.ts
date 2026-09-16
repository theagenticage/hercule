/**
 * The runner socket. A runner is an HTTP client of its own, so unlike a browser
 * it can put a credential on the handshake; that credential is checked before
 * the upgrade and buys nothing else anywhere in Hydra.
 *
 * The proof runs the other way too: `greet` signs the runner's nonce beside its
 * id, and `signedChallenge` in `@hydra/protocol` says why both are in there.
 *
 * Liveness is a protocol frame, never a WebSocket control frame: Bun answers a
 * control ping in the runtime, which would prove the machine is up rather than
 * the runner process.
 *
 * The loop is awaited inline in the handler. Forking it before returning the
 * response kills it with the request scope, and the server receives nothing.
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
import { internal, unauthenticated } from "@hydra/contract";
import {
  ControllerToRunner,
  GOING_AWAY_CLOSE_CODE,
  PeerVersion,
  PROTOCOL_VERSION,
  RunnerFactsRequest,
  RunnerToController,
  signedChallenge,
  type ControllerHello,
  type RunnerHello,
} from "@hydra/protocol";
import { bearerOf } from "../http/bearer";
import { responseFor } from "../http/envelope";
import { ControllerIdentity } from "../identity";
import { SessionService } from "../sessions";
import { WorkspaceService } from "../workspaces";
import { newConnection, RunnerPresence, type Connection, type Departure } from "./presence";

const RUNNER_SOCKET_PATH = "/api/v1/runners/socket";

export const RUNNER_PING_INTERVAL: Duration.Duration = Duration.seconds(15);

/** Four missed intervals: one lost answer is a hiccup, four in a row is a machine. */
export const RUNNER_SILENCE_LIMIT: Duration.Duration = Duration.seconds(60);

/** Tests hand over values they can wait out. */
export interface RunnerPings {
  readonly interval: Duration.Duration;
  readonly silence: Duration.Duration;
}

export const RunnerPingSchedule = Context.Reference<RunnerPings>(
  "hydra/controller/runners/RunnerPingSchedule",
  {
    defaultValue: (): RunnerPings => ({
      interval: RUNNER_PING_INTERVAL,
      silence: RUNNER_SILENCE_LIMIT,
    }),
  },
);

const NO_CREDENTIAL = "the runner socket needs a runner's credential";

/**
 * A runner that was retired is told so, because its operator can act on it:
 * re-enlist the machine. Every other refusal says the same nothing, since the
 * difference between a credential never minted and one from another controller
 * is a probe.
 */
const UNKNOWN_CREDENTIAL = "unknown credential";

const RETIRED = "this runner was retired";

/** Empty in v1: the seam exists, and nothing has been built to negotiate yet. */
const CAPABILITIES: ReadonlyArray<string> = [];

const UNREADABLE = "that is not a message this controller can read";
const WRONG_VERSION = `this controller speaks runner protocol version ${String(PROTOCOL_VERSION)}`;
const GREETED_ALREADY = "this connection has already said hello";

/** RFC 6455's protocol error; the other codes this file writes live in the protocol. */
const PROTOCOL_ERROR = 1002;

const SILENT = "this runner stopped answering";

const decodeFrame = Schema.decodeUnknownEffect(RunnerToController);
const decodePeerVersion = Schema.decodeUnknownEffect(PeerVersion);
const encodeFrame = Schema.encodeUnknownSync(ControllerToRunner);

const asText = (message: typeof ControllerToRunner.Type): string =>
  JSON.stringify(encodeFrame(message));

const FACTS_REQUEST = asText({ _tag: "factsRequest" } satisfies RunnerFactsRequest);

/** What both ends offer, which is the only thing either may use. */
const negotiated = (theirs: ReadonlyArray<string>): ReadonlyArray<string> =>
  CAPABILITIES.filter((capability) => theirs.includes(capability));

/**
 * `mine` names this connection, so what it writes on its way out is dropped if
 * the runner already dialled again, and `departure` stays `unreachable` until a
 * `Goodbye` makes it an announcement.
 */
const hold = (runnerId: string, socket: Socket.Socket) =>
  Effect.gen(function* () {
    const presence = yield* RunnerPresence;
    const sessions = yield* SessionService;
    const workspaces = yield* WorkspaceService;
    const identity = yield* ControllerIdentity;
    const pings = yield* RunnerPingSchedule;
    const write = yield* socket.writer;

    const mine: Connection = newConnection();
    let greeted = false;
    let departure: Departure = "unreachable";
    let lastHeard = yield* Clock.currentTimeMillis;

    /** Resolves with what presence asked this connection to go out with. */
    const asked = Deferred.makeUnsafe<Socket.CloseEvent>();

    const refuse = (reason: string) => write(new Socket.CloseEvent(PROTOCOL_ERROR, reason));

    const greet = (hello: RunnerHello) =>
      Effect.gen(function* () {
        const controller = yield* identity.read;
        if (Option.isNone(controller)) {
          // The boot creates the identity before anything binds, so this is a
          // bug rather than a state to answer.
          return yield* Effect.die("the controller has no identity row");
        }
        const signature = yield* identity.sign(signedChallenge(runnerId, hello.nonce));
        const answer: ControllerHello = {
          _tag: "controllerHello",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          identityId: controller.value.id,
          publicKey: Buffer.from(controller.value.publicKey).toString("base64"),
          nonce: hello.nonce,
          signature: Buffer.from(signature).toString("base64"),
        };
        // Before the answer goes out, so a runner told it is in is one the fleet
        // already reads as online.
        yield* presence.greeted(
          runnerId,
          mine,
          {
            close: (code, reason) => {
              Deferred.doneUnsafe(asked, Exit.succeed(new Socket.CloseEvent(code, reason)));
            },
            // A write that fails is a connection that is going; the operation
            // waiting on the answer meets that as its deadline.
            askForFacts: Effect.ignore(write(FACTS_REQUEST)),
            ask: (request) => Effect.ignore(write(asText(request))),
          },
          {
            binaryVersion: hello.binaryVersion,
            protocolVersion: hello.protocolVersion,
            negotiatedCapabilities: negotiated(hello.capabilities),
            facts: hello.facts,
          },
        );
        greeted = true;
        yield* write(asText(answer));
        // After the answer, because the runner drops every frame that reaches
        // it before the controller's hello: a sweep announced any earlier can
        // have its first probe thrown away.
        yield* presence.arrived(runnerId);
      });

    const handle = (raw: string) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.option(
          Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }),
        );
        if (Option.isNone(parsed)) return yield* refuse(UNREADABLE);
        // Read before the frame, because a later peer's hello will not decode
        // here and would otherwise be called gibberish rather than a mismatch.
        const version = yield* Effect.option(decodePeerVersion(parsed.value));
        if (Option.isSome(version) && version.value.protocolVersion !== PROTOCOL_VERSION) {
          return yield* refuse(WRONG_VERSION);
        }
        const frame = yield* Effect.option(decodeFrame(parsed.value));
        if (Option.isNone(frame)) return yield* refuse(UNREADABLE);
        const message = frame.value;
        switch (message._tag) {
          case "runnerHello":
            // Without this a runner could make the controller sign and write for
            // every frame it cares to send.
            if (greeted) return yield* refuse(GREETED_ALREADY);
            return yield* greet(message);
          case "pong":
            // The only frame that counts as an answer, and only from a
            // connection that has said who it is: otherwise anything holding a
            // credential could keep a row reading as last seen a moment ago.
            if (!greeted) return;
            lastHeard = yield* Clock.currentTimeMillis;
            return yield* presence.answered(runnerId);
          case "factsReport":
            // Until the hello lands, all this connection has shown is that
            // somebody holds a credential.
            if (!greeted) return;
            return yield* presence.reportedFacts(runnerId, mine, message.facts);
          case "watermarkReport":
            if (!greeted) return;
            yield* presence.reportedWatermark(runnerId, mine, message.watermark);
            // Outside the write above: dispatch may tell this runner, and a
            // transaction never spans a wait on anything outside the database.
            return yield* sessions.dispatch(runnerId);
          case "probeReport":
          case "installResult":
          case "loginUrl":
          case "loginFailed":
          case "loginResult":
          case "sessionInputResult":
            if (!greeted) return;
            return yield* presence.reportedAnswer(runnerId, mine, message);
          case "workspaceReport":
            if (!greeted) return;
            return yield* workspaces.reported(runnerId, message);
          case "credentialRequest":
            if (!greeted) return;
            return yield* workspaces.credentialAsked(runnerId, message);
          case "sessionEvent":
          case "sessionsReport":
            // Handed on rather than handled: what a session event means belongs
            // to the session domain, and this file's job is the wire.
            if (!greeted) return;
            return yield* presence.reportedSession(runnerId, mine, message);
          case "goodbye":
            departure = "offline";
            return;
        }
        // Every frame the protocol declares is answered above. A new one that
        // reaches here would otherwise be dropped in silence.
        return message satisfies never;
      });

    // The transport forks a fiber per frame, so two arriving together would
    // otherwise run the exchange twice over the same four variables.
    const frames = yield* Semaphore.make(1);
    const receive = (raw: string) => frames.withPermits(1)(handle(raw));

    /** Raced against the receive loop, so neither outlives the other by a frame. */
    const ask = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(pings.interval);
        if ((yield* Clock.currentTimeMillis) - lastHeard > Duration.toMillis(pings.silence)) {
          return yield* write(new Socket.CloseEvent(GOING_AWAY_CLOSE_CODE, SILENT));
        }
        yield* write(asText({ _tag: "ping" }));
      }
    });

    const closeWhenAsked = Effect.flatMap(Deferred.await(asked), write);

    /**
     * A finaliser because a runner that hangs up aborts the request, and an
     * aborted request interrupts the fiber serving it: without this the one
     * write that matters most, the row leaving online, never happens.
     */
    const leave = Effect.suspend(() => presence.ended(runnerId, mine, departure));

    yield* Effect.ensuring(
      Effect.race(
        Effect.tapCause(socket.runString(receive), (cause) =>
          Effect.logError("A runner's connection ended in an error", cause),
        ).pipe(Effect.ignore),
        Effect.race(ask, closeWhenAsked),
      ),
      Effect.tapCause(leave, (cause) =>
        Effect.logError("A runner's row could not be moved off online", cause),
      ).pipe(Effect.ignore),
    );
  });

/** Resolved before the upgrade, so a refusal is an ordinary `401` in the envelope. */
export const RunnerSocketRouteLayer = HttpRouter.add("GET", RUNNER_SOCKET_PATH, (request) =>
  Effect.gen(function* () {
    const presence = yield* RunnerPresence;
    const credential = bearerOf(request);
    if (credential === undefined) return responseFor(unauthenticated(NO_CREDENTIAL));
    // A database that will not answer is not a credential that was refused, and
    // a runner told `unauthenticated` stops presenting a credential still good.
    const admitted = yield* Effect.catch(presence.admits(credential), (error) =>
      Effect.as(Effect.logError("A runner's credential could not be resolved", error), undefined),
    );
    if (admitted === undefined) return responseFor(internal("something went wrong"));
    if (Option.isNone(admitted)) {
      const retired = yield* Effect.catch(presence.wasRetired(credential), (error) =>
        Effect.as(Effect.logError("A refused credential could not be looked up", error), false),
      );
      return responseFor(unauthenticated(retired ? RETIRED : UNKNOWN_CREDENTIAL));
    }

    const socket = yield* request.upgrade;
    // Once the connection is up there is nobody left to answer with a status.
    yield* hold(admitted.value, socket);
    return HttpServerResponse.empty();
  }).pipe(Effect.withSpan("runner.socket")),
);
