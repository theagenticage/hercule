/**
 * The runner socket: the one connection a runner holds with its controller.
 *
 * A runner is an HTTP client of its own, so unlike a browser it can put a
 * credential on the handshake. It does, and that credential is checked before
 * the upgrade: a machine that cannot present one is refused with a `401` and
 * never costs a socket. The credential buys nothing else anywhere in Hydra.
 *
 * The proof runs the other way too. A runner pins a logical identity rather
 * than an address, so its hello carries a nonce and the answer carries the
 * controller's id, its public key and an Ed25519 signature over that nonce and
 * the runner's own id. A runner that dialled an impostor sees the signature
 * fail and hangs up.
 *
 * What the runner says about its machine - the facts it probed and the
 * headroom it keeps refreshing - is latest-wins state and nothing more. It is
 * stored whole, it advances no liveness, and it is acted on only on the
 * connection the runner is currently reachable through.
 *
 * Liveness is a protocol frame and never a WebSocket control frame. Bun answers
 * a control ping in the runtime, so a control frame proves the machine is up
 * rather than that the runner process is; `Ping` and `Pong` are messages the
 * runner's own loop has to answer.
 *
 * The loop is awaited inline in the handler. Forking it before returning the
 * response kills it with the request scope, and the server then silently
 * receives nothing.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/unstable/socket/Socket";
import { internal, unauthenticated } from "@hydra/contract";
import {
  ControllerToRunner,
  PeerVersion,
  PROTOCOL_VERSION,
  RunnerToController,
  signedChallenge,
  type ControllerHello,
  type RunnerHello,
} from "@hydra/protocol";
import { bearerOf } from "../http/bearer";
import { responseFor } from "../http/envelope";
import { ControllerIdentity } from "../identity/repository";
import { newConnection, RunnerPresence, type Connection, type Departure } from "./presence";

/** Where a runner dials, beside the join it was enlisted through. */
const RUNNER_SOCKET_PATH = "/api/v1/runners/socket";

/** How often the controller asks a runner it is holding whether it is there. */
export const RUNNER_PING_INTERVAL: Duration.Duration = Duration.seconds(15);

/**
 * How long a runner may say nothing before the controller stops believing it is
 * there. Four missed intervals: one lost answer is a network hiccup, four in a
 * row is a machine.
 */
export const RUNNER_SILENCE_LIMIT: Duration.Duration = Duration.seconds(60);

/** What the liveness check runs on. Tests hand over values they can wait out. */
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
 * What every hello this build makes offers. Empty in v1: the seam exists so
 * plan-shipping and OS sandboxing can be turned on only where both ends have
 * them, and nothing has been built to negotiate yet.
 */
const CAPABILITIES: ReadonlyArray<string> = [];

/** A frame the catalogue cannot read, or a hello in a version this build cannot speak. */
const UNREADABLE = "that is not a message this controller can read";
const WRONG_VERSION = `this controller speaks runner protocol version ${String(PROTOCOL_VERSION)}`;
const GREETED_ALREADY = "this connection has already said hello";
const DISPLACED = "this runner opened another connection";

/** How a refusal ends the connection. 1002 is the protocol error a WebSocket has. */
const PROTOCOL_ERROR = 1002;

/** How a connection the controller has stopped believing in ends. */
const GOING_AWAY = 1001;
const SILENT = "this runner stopped answering";

const decodeFrame = Schema.decodeUnknownEffect(RunnerToController);
const decodePeerVersion = Schema.decodeUnknownEffect(PeerVersion);
const encodeFrame = Schema.encodeUnknownSync(ControllerToRunner);

const asText = (message: typeof ControllerToRunner.Type): string =>
  JSON.stringify(encodeFrame(message));

/** What both ends offer, which is the only thing either may use. */
const negotiated = (theirs: ReadonlyArray<string>): ReadonlyArray<string> =>
  CAPABILITIES.filter((capability) => theirs.includes(capability));

/**
 * The connection, from the upgrade to the end of it.
 *
 * `mine` names this connection, so what it writes on its way out is dropped if
 * the runner has already dialled again. `departure` is `unreachable` until the
 * runner says otherwise: silence is the default reading of a connection that
 * stopped, and only a `Goodbye` makes it an announcement.
 */
const hold = (runnerId: string, socket: Socket.Socket) =>
  Effect.gen(function* () {
    const presence = yield* RunnerPresence;
    const identity = yield* ControllerIdentity;
    const pings = yield* RunnerPingSchedule;
    const write = yield* socket.writer;

    const mine: Connection = newConnection();
    let greeted = false;
    let departure: Departure = "unreachable";
    let lastHeard = yield* Clock.currentTimeMillis;

    /** Opened when this runner turns up on a connection that is not this one. */
    const displaced = Latch.makeUnsafe(false);

    const refuse = (reason: string) => write(new Socket.CloseEvent(PROTOCOL_ERROR, reason));

    /** The answer to a hello: the identity the runner pins, over its own challenge. */
    const greet = (hello: RunnerHello) =>
      Effect.gen(function* () {
        const controller = yield* identity.read;
        if (Option.isNone(controller)) {
          // The boot creates the identity before anything binds, so serving a
          // socket without one is a bug rather than a state to answer.
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
        // The row is written before the answer goes out, so a runner that is
        // told it is in is a runner the fleet already reads as online.
        yield* presence.greeted(runnerId, mine, () => void displaced.openUnsafe(), {
          binaryVersion: hello.binaryVersion,
          protocolVersion: hello.protocolVersion,
          negotiatedCapabilities: negotiated(hello.capabilities),
          facts: hello.facts,
        });
        greeted = true;
        yield* write(asText(answer));
      });

    const handle = (raw: string) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.option(
          Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }),
        );
        if (Option.isNone(parsed)) return yield* refuse(UNREADABLE);
        // The version is read before the frame is, because a peer on a later
        // version sends a hello this build's schema cannot decode and would
        // otherwise be told its frame was gibberish rather than its version.
        const version = yield* Effect.option(decodePeerVersion(parsed.value));
        if (Option.isSome(version) && version.value.protocolVersion !== PROTOCOL_VERSION) {
          return yield* refuse(WRONG_VERSION);
        }
        const frame = yield* Effect.option(decodeFrame(parsed.value));
        if (Option.isNone(frame)) return yield* refuse(UNREADABLE);
        const message = frame.value;
        switch (message._tag) {
          case "runnerHello":
            // One hello per connection. Without this a runner could make the
            // controller sign and write for every frame it cares to send.
            if (greeted) return yield* refuse(GREETED_ALREADY);
            return yield* greet(message);
          case "pong":
            // The answer to the question, and the only frame that counts as
            // one. A runner whose pong path is broken but whose other reports
            // still arrive is a runner nothing can place work on.
            //
            // Only a connection that has said who it is is answering: without
            // that, anything holding a credential could keep a row reading as
            // last seen a moment ago while never joining the fleet at all.
            if (!greeted) return;
            lastHeard = yield* Clock.currentTimeMillis;
            return yield* presence.answered(runnerId);
          case "factsReport":
            // Nothing a runner says about itself is worth storing before it has
            // said who it is: until the hello lands, all this connection has
            // shown is that somebody holds a credential.
            if (!greeted) return;
            return yield* presence.reportedFacts(runnerId, mine, message.facts);
          case "watermarkReport":
            if (!greeted) return;
            return yield* presence.reportedWatermark(runnerId, mine, message.watermark);
          case "goodbye":
            departure = "offline";
            return;
        }
      });

    // The transport forks a fiber per frame, so two frames arriving together
    // would otherwise run the exchange twice over the same four variables.
    const frames = yield* Semaphore.make(1);
    const receive = (raw: string) => frames.withPermits(1)(handle(raw));

    /**
     * Asks, on the interval, and gives up on a runner that has stopped
     * answering. Racing the receive loop rather than forking it means neither
     * outlives the other by so much as a frame.
     */
    const ask = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(pings.interval);
        if ((yield* Clock.currentTimeMillis) - lastHeard > Duration.toMillis(pings.silence)) {
          return yield* write(new Socket.CloseEvent(GOING_AWAY, SILENT));
        }
        yield* write(asText({ _tag: "ping" }));
      }
    });

    /** Hangs up when the same runner turns up on a newer connection. */
    const yieldToNewer = Effect.andThen(
      displaced.await,
      write(new Socket.CloseEvent(GOING_AWAY, DISPLACED)),
    );

    /**
     * What the row is left saying. Every way of ending is silence unless the
     * runner announced otherwise, including a close this controller made
     * itself; a connection that never came online is not this runner's and
     * `ended` drops it.
     *
     * It runs as a finaliser because a runner that hangs up aborts the request,
     * and an aborted request interrupts the fiber serving it: without this the
     * one write that matters most - the row no longer being online - would be
     * the one write that never happens.
     */
    const leave = Effect.suspend(() => presence.ended(runnerId, mine, departure));

    yield* Effect.ensuring(
      Effect.race(
        Effect.tapCause(socket.runString(receive), (cause) =>
          Effect.logError("A runner's connection ended in an error", cause),
        ).pipe(Effect.ignore),
        Effect.race(ask, yieldToNewer),
      ),
      Effect.tapCause(leave, (cause) =>
        Effect.logError("A runner's row could not be moved off online", cause),
      ).pipe(Effect.ignore),
    );
  });

/**
 * The socket route. The credential is resolved before the upgrade, so a refusal
 * is an ordinary `401` in the error envelope and no connection is ever opened
 * for a machine that could not present one.
 */
export const RunnerSocketRouteLayer = HttpRouter.add("GET", RUNNER_SOCKET_PATH, (request) =>
  Effect.gen(function* () {
    const presence = yield* RunnerPresence;
    const credential = bearerOf(request);
    if (credential === undefined) return responseFor(unauthenticated(NO_CREDENTIAL));
    // A database that will not answer is not a credential that was refused: a
    // runner told `unauthenticated` has no reason to present that credential
    // again, and this one is still good.
    const admitted = yield* Effect.catch(presence.admits(credential), (error) =>
      Effect.as(Effect.logError("A runner's credential could not be resolved", error), undefined),
    );
    if (admitted === undefined) return responseFor(internal("something went wrong"));
    if (Option.isNone(admitted)) return responseFor(unauthenticated(NO_CREDENTIAL));

    const socket = yield* request.upgrade;
    // Once the connection is up there is nobody left to answer with a status:
    // whatever went wrong is logged inside and the connection ends.
    yield* hold(admitted.value, socket);
    return HttpServerResponse.empty();
  }).pipe(Effect.withSpan("runner.socket")),
);
