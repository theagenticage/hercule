/**
 * The runner's end of the connection it holds with its controller.
 *
 * One connection, from the dial to whatever ends it. The credential rides the
 * upgrade request, because a runner owns its HTTP client and can put a header
 * on a handshake where a browser cannot; nothing on the socket carries it.
 *
 * What the runner checks in return is that it is talking to *its* controller. A
 * controller is a logical identity, not an address, so the runner sends a fresh
 * nonce and refuses to go on unless the answer carries the id and the public key
 * its `runner.json` holds and an Ed25519 signature made with that key over that
 * nonce and this runner's own id. All three must hold: an id it recognises is
 * not licence to trust whatever key arrives beside it.
 *
 * Once the proof is in, the connection also carries what this machine has to
 * say about itself: its headroom at once and every minute after, and its facts
 * again whenever an hourly probe finds them changed. Both stop with the
 * connection, because a report nobody can hear is not worth keeping.
 *
 * This returns when the connection ends, however it ends. Holding one open
 * again afterwards is `./reconnect.ts`.
 */
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/unstable/socket/Socket";
import { VERSION } from "@hydra/home/version";
import {
  ControllerToRunner,
  PeerVersion,
  PROTOCOL_VERSION,
  RunnerToController,
  signedChallenge,
  type ControllerHello,
  type RunnerFacts,
} from "@hydra/protocol";
import { refreshFacts } from "./probe";
import { checkWatermark, type Headroom } from "./watermark";

/** Where a runner dials, on the authority its `runner.json` names. */
const SOCKET_PATH = "/api/v1/runners/socket";

/** How many random bytes a nonce is. Sixteen is what a challenge needs. */
const NONCE_BYTES = 16;

/** The algorithm the controller's identity is signed and verified under. */
const ED25519 = { name: "Ed25519" } as const;

/** How the runner ends a connection it will not speak on. */
const PROTOCOL_ERROR = 1002;

/**
 * How long the peer has to prove who it is. A controller answers a hello in the
 * time one signature takes; anything that has not answered in ten seconds is
 * something the runner should stop waiting on and dial again, because until the
 * proof arrives this connection has passed no check at all.
 */
export const PROOF_DEADLINE: Duration.Duration = Duration.seconds(10);

/** What `runner.json` says about the controller this runner belongs to. */
export interface ControllerPin {
  /** Who this machine is to that controller. Part of what the answer is signed over. */
  readonly runnerId: string;
  /** Where the controller answers, as the join was told. */
  readonly controllerUrl: string;
  /** The durable credential the join handed back. */
  readonly credential: string;
  readonly controllerIdentityId: string;
  /** The Ed25519 public key, standard base64 over raw SPKI bytes. */
  readonly controllerPublicKey: string;
}

/** What one connection needs to know. */
export interface ConnectOptions {
  readonly pin: ControllerPin;
  /** What this machine says about itself, which the hello carries. */
  readonly facts: RunnerFacts;
  /** How to look at the machine again, for the refresh. */
  readonly probe: Effect.Effect<RunnerFacts>;
  /** How to read what the machine has left, for the minute-by-minute report. */
  readonly headroom: Effect.Effect<Headroom, Cause.UnknownError>;
  /** What this build can do that both ends have to list to use. */
  readonly capabilities?: ReadonlyArray<string>;
  /** How long the peer has to prove who it is. The shipped value unless a test says otherwise. */
  readonly proofDeadline?: Duration.Duration;
}

/**
 * The peer that answered did not prove it is the controller this runner joined.
 * Its own error because it is the one failure retrying will not fix by itself:
 * a runner in this state is being impersonated, pointed at the wrong address,
 * or holding a `runner.json` that no longer describes anything.
 */
export class ControllerNotRecognised extends Schema.TaggedError<ControllerNotRecognised>()(
  "ControllerNotRecognised",
  { message: Schema.String },
) {}

/**
 * The controller speaks a version of this protocol that this build does not.
 * Its own error because it is the one refusal an operator can act on: upgrade
 * the runner. Retrying is still right - a controller is upgraded in place - but
 * every attempt will fail the same way until somebody does something.
 */
export class ProtocolMismatch extends Schema.TaggedError<ProtocolMismatch>()("ProtocolMismatch", {
  message: Schema.String,
}) {}

const decodeFrame = Schema.decodeUnknownEffect(ControllerToRunner);
const decodePeerVersion = Schema.decodeUnknownEffect(PeerVersion);

const UNREADABLE = "the controller sent something this build cannot read";
const encodeFrame = Schema.encodeUnknownSync(RunnerToController);

const asText = (message: typeof RunnerToController.Type): string =>
  JSON.stringify(encodeFrame(message));

/** The bytes base64 stands for, in the buffer WebCrypto's types ask for. */
const asBytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
};

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Where the socket lives, given the controller URL a join was told. */
const socketUrlFor = (controllerUrl: string): string => {
  const url = new URL(SOCKET_PATH, controllerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

/**
 * Whether this hello was made by the controller the runner joined. The
 * signature is checked last, because the key it is checked against is only the
 * runner's own once the two before it have held.
 */
const isOurs = (
  hello: ControllerHello,
  pin: ControllerPin,
  nonce: string,
): Effect.Effect<boolean> =>
  hello.identityId !== pin.controllerIdentityId || hello.publicKey !== pin.controllerPublicKey
    ? Effect.succeed(false)
    : Effect.promise(async () => {
        const key = await crypto.subtle.importKey(
          "spki",
          asBytes(pin.controllerPublicKey),
          ED25519,
          false,
          ["verify"],
        );
        return crypto.subtle.verify(
          ED25519,
          key,
          asBytes(hello.signature),
          signedChallenge(pin.runnerId, nonce),
        );
      }).pipe(
        // A key the runner cannot even import cannot have signed anything.
        Effect.catchCause(() => Effect.succeed(false)),
      );

/**
 * Holds one connection until it ends.
 *
 * Fails with `ControllerNotRecognised` when the answer was not this runner's
 * controller's, and with a transport error for every other way a connection
 * ends - including an ordinary close, because a runner that is not connected
 * has to dial again whatever the reason.
 */
export const connect = (
  options: ConnectOptions,
): Effect.Effect<void, ControllerNotRecognised | ProtocolMismatch | Socket.SocketError> =>
  Effect.gen(function* () {
    const { pin } = options;
    const url = socketUrlFor(pin.controllerUrl);
    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(url, {
              headers: { authorization: `Bearer ${pin.credential}` },
            } as unknown as string[]),
        ),
        // A connection still open at the end of this scope is one this runner
        // is walking away from rather than one it lost - the process was asked
        // to stop, or this build will not speak to that controller. Saying so
        // is what tells the controller `offline` from silence, and the frame
        // goes out on the socket itself because everything above it is already
        // being torn down. A connection the peer or the network ended is not
        // open here, and nothing is said over it.
        (ws) =>
          Effect.sync(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(asText({ _tag: "goodbye" }));
            ws.close(1000);
          }),
      ),
    );
    const write = yield* socket.writer;

    const nonce = base64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
    let greeted = false;
    /** Opened when the peer has proved it is this runner's controller. */
    const proven = Latch.makeUnsafe(false);
    let impostor: ControllerNotRecognised | undefined;

    /** Stops talking and hangs up. Nothing further goes out on this connection. */
    const disown = (message: string) =>
      Effect.gen(function* () {
        impostor = new ControllerNotRecognised({ message });
        yield* write(new Socket.CloseEvent(PROTOCOL_ERROR, "unrecognised controller"));
      });

    const handle = (raw: string) =>
      Effect.gen(function* () {
        if (impostor !== undefined) return;
        const parsed = yield* Effect.option(
          Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }),
        );
        if (Option.isNone(parsed)) return yield* disown(UNREADABLE);
        // The version is read before the frame is, because a controller on a
        // later version sends a hello this build's schema cannot decode; being
        // told the versions differ is what an operator can act on.
        const version = yield* Effect.option(decodePeerVersion(parsed.value));
        if (Option.isSome(version) && version.value.protocolVersion !== PROTOCOL_VERSION) {
          return yield* Effect.fail(
            new ProtocolMismatch({
              message: `the controller speaks runner protocol version ${String(version.value.protocolVersion)}, this runner speaks ${String(PROTOCOL_VERSION)}`,
            }),
          );
        }
        const frame = yield* Effect.option(decodeFrame(parsed.value));
        // Whatever is on the other end, it is not speaking this protocol, so
        // there is nothing to go on holding the connection for.
        if (Option.isNone(frame)) return yield* disown(UNREADABLE);
        const message = frame.value;
        if (message._tag === "controllerHello") {
          // The proof is made once. A second hello can only weaken what the
          // first one settled, so it is not looked at.
          if (greeted) return;
          if (!(yield* isOurs(message, pin, nonce))) {
            return yield* disown("that is not the controller this runner joined");
          }
          greeted = true;
          proven.openUnsafe();
          return;
        }
        // Nothing but the hello is answered before the hello: a peer that has
        // not proved who it is gets no evidence that this runner is alive.
        if (!greeted) return;
        if (message._tag === "ping") return yield* write(asText({ _tag: "pong" }));
        // An ack belongs to the replayable events nothing sends yet.
      });

    // The transport forks a fiber per frame, so two frames arriving together
    // would otherwise run the exchange twice over the same three flags.
    const frames = yield* Semaphore.make(1);
    const receive = (raw: string) => frames.withPermits(1)(handle(raw));

    /**
     * Waits for the proof, gives up on a peer that never offers one, and then
     * spends the rest of the connection saying what this machine is like.
     *
     * The deadline is only ever the answer before the proof arrives. One that
     * could still fire on a proven connection would hang a healthy runner up
     * every ten seconds for the life of the process.
     */
    const reporting = Effect.gen(function* () {
      const proved = yield* Effect.raceFirst(
        Effect.as(proven.await, true),
        Effect.as(Effect.sleep(options.proofDeadline ?? PROOF_DEADLINE), false),
      );
      if (!proved) return yield* disown("the controller did not say who it is");
      yield* Effect.all(
        [
          checkWatermark({
            read: options.headroom,
            send: (watermark) => write(asText({ _tag: "watermarkReport", watermark })),
          }),
          refreshFacts({
            probe: options.probe,
            reported: options.facts,
            send: (facts) => write(asText({ _tag: "factsReport", facts })),
          }),
        ],
        { concurrency: "unbounded" },
      );
    });

    // `raceFirst`, not `race`: the connection ending is a failure, and `race`
    // would wait out the deadline rather than take it as the answer.
    yield* Effect.raceFirst(
      socket.runString(receive, {
        onOpen: write(
          asText({
            _tag: "runnerHello",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: options.capabilities ?? [],
            binaryVersion: VERSION,
            nonce,
            facts: options.facts,
          }),
        ).pipe(Effect.ignore),
      }),
      reporting,
    ).pipe(
      // However the connection ended, being hung up on by an impostor is the
      // more useful answer than the close that followed it.
      Effect.catch((error) => (impostor === undefined ? Effect.fail(error) : Effect.void)),
    );

    if (impostor !== undefined) return yield* Effect.fail(impostor);
  }).pipe(Effect.scoped);
