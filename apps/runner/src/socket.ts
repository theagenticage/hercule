/**
 * The runner's end of one connection. Holding one open again is `./reconnect.ts`.
 *
 * The credential rides the upgrade request, because a runner owns its HTTP
 * client and can put a header on a handshake where a browser cannot.
 *
 * A controller is a logical identity, not an address, so the runner sends a
 * fresh nonce and requires the id, the public key and a signature over that
 * nonce and its own id, all three: an id it recognises is not licence to trust
 * whatever key arrives beside it.
 */
import { mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
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
  RETIRED_CLOSE_CODE,
  RETIRED_CLOSE_REASON,
  RunnerToController,
  signedChallenge,
  type ControllerHello,
  MAX_FACT_LENGTH,
  type InstallRequest,
  type LoginStart,
  type ProbeRequest,
  type ProbeResult,
  type RunnerFacts,
  type RunnerWatermark,
} from "@hydra/protocol";
import { refreshFacts } from "./probe";
import { wentWrong } from "./report";
import {
  adapterFor,
  noAdapterFor,
  probeFailed,
  providerLogins,
  type InstallOutcome,
  type ProviderAdapter,
  type ProviderRunnerContext,
} from "./providers";
import type { LoginAnswer } from "./providers/login";
import { sessions } from "./sessions";
import { checkWatermark } from "./watermark";

const SOCKET_PATH = "/api/v1/runners/socket";

const NONCE_BYTES = 16;

const ED25519 = { name: "Ed25519" } as const;

/** The RFC 6455 protocol-error close code. */
const PROTOCOL_ERROR = 1002;

/** Until the proof arrives this connection has passed no check, so waiting buys nothing. */
export const PROOF_DEADLINE: Duration.Duration = Duration.seconds(10);

/** What `runner.json` says about the controller this runner belongs to. */
export interface ControllerPin {
  /** Who this machine is to that controller, and part of what the answer signs. */
  readonly runnerId: string;
  readonly controllerUrl: string;
  readonly credential: string;
  readonly controllerIdentityId: string;
  /** Standard base64 over raw SPKI bytes. */
  readonly controllerPublicKey: string;
}

export interface ConnectOptions {
  readonly pin: ControllerPin;
  readonly facts: RunnerFacts;
  readonly probe: Effect.Effect<RunnerFacts>;
  readonly headroom: Effect.Effect<RunnerWatermark, Cause.UnknownError>;
  /**
   * Where provider instances keep their own config directories on this machine.
   * One per instance, so two accounts of one harness never read each other's
   * credential, and never the user's own.
   */
  readonly providersDir: string;
  /**
   * Where a workspace-less session gets its empty scratch cwd, one directory
   * per session, removed when the session exits (spec 06 section 9.1).
   */
  readonly scratchDir: string;
  /** The shipped deadline unless a test says otherwise. */
  readonly proofDeadline?: Duration.Duration;
}

/**
 * Its own error because retrying will not fix it: the runner is impersonated,
 * misdirected, or holding a `runner.json` that describes nothing.
 */
export class ControllerNotRecognised extends Schema.TaggedError<ControllerNotRecognised>()(
  "ControllerNotRecognised",
  { message: Schema.String },
) {}

/**
 * Its own error because dialling again is exactly the wrong answer: the
 * controller has retired this machine and revoked its credential, so the loop
 * stops and the daemon says what the operator has to do about it.
 */
export class RunnerRetired extends Schema.TaggedError<RunnerRetired>()("RunnerRetired", {
  message: Schema.String,
}) {}

export const RETIRED_MESSAGE = "this runner was retired; run `hydra runner join` to re-enlist";

/** Its own error because an operator can act on it: upgrade the runner. */
export class ProtocolMismatch extends Schema.TaggedError<ProtocolMismatch>()("ProtocolMismatch", {
  message: Schema.String,
}) {}

const decodeFrame = Schema.decodeUnknownEffect(ControllerToRunner);
const decodePeerVersion = Schema.decodeUnknownEffect(PeerVersion);

const UNREADABLE = "the controller sent something this build cannot read";
const encodeFrame = Schema.encodeUnknownSync(RunnerToController);

const asText = (message: typeof RunnerToController.Type): string =>
  JSON.stringify(encodeFrame(message));

/** In the buffer WebCrypto's types ask for, which a Node `Buffer` is not. */
const asBytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
};

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const retiredIn = (error: unknown): boolean =>
  error instanceof Socket.SocketError &&
  error.reason._tag === "SocketCloseError" &&
  error.reason.code === RETIRED_CLOSE_CODE &&
  error.reason.closeReason === RETIRED_CLOSE_REASON;

const socketUrlFor = (controllerUrl: string): string => {
  const url = new URL(SOCKET_PATH, controllerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

/** The signature is checked last: the key is only the runner's once the ids match. */
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

/** Even an ordinary close is a failure here: a disconnected runner must dial again. */
export const connect = (
  options: ConnectOptions,
): Effect.Effect<
  void,
  ControllerNotRecognised | ProtocolMismatch | RunnerRetired | Socket.SocketError
> =>
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
        // Still open at the end of this scope means this runner is walking away
        // rather than losing it, and saying so is what tells the controller
        // `offline` from silence. The frame goes out on the socket itself
        // because everything above it is already being torn down.
        (ws) =>
          Effect.sync(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(asText({ _tag: "goodbye" }));
            ws.close(1000);
          }),
      ),
    );
    const write = yield* socket.writer;
    // A probe or an install outlives the frame that asked for it, so it is
    // forked into the connection's scope, not the transport's per-frame fiber.
    const connection = yield* Effect.scope;

    const nonce = base64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
    let greeted = false;
    // The machine as this connection last described it. An install changes what
    // is on it, and the probe that follows has to reach the binary that was
    // just put there rather than the one the hello knew about.
    let facts = options.facts;
    const proven = Latch.makeUnsafe(false);
    // The deadline below is the peer's time to answer, not the network's time
    // to connect: a dial that took most of it would otherwise leave a
    // perfectly good controller no room to say who it is.
    const opened = Latch.makeUnsafe(false);
    let impostor: ControllerNotRecognised | undefined;

    const disown = (message: string) =>
      Effect.gen(function* () {
        impostor = new ControllerNotRecognised({ message });
        yield* write(new Socket.CloseEvent(PROTOCOL_ERROR, "unrecognised controller"));
      });

    const reportFacts = Effect.tap(options.probe, (probed) =>
      Effect.sync(() => {
        facts = probed;
      }),
    );

    const binaryOf = (binaryName: string): string | undefined =>
      facts.providers.find((provider) => provider.name === binaryName && provider.present)?.path;

    /** The instance's private directory: where the harness keeps its credential. */
    const contextFor = (adapter: ProviderAdapter, instanceId: string): ProviderRunnerContext => {
      const home = joinPath(options.providersDir, instanceId);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // Probes, logins and installs run nowhere: a cwd is a session's, and the
      // session supervisor builds its own context (spec 06 section 4.2).
      return { cwd: null, home, binary: binaryOf(adapter.binaryName), env: process.env };
    };

    // The connection lends the supervisor a way to write and the paths this
    // machine resolved; the sessions themselves are the process's.
    const supervisor = sessions.forConnection({
      send: (frame) => write(asText(frame)),
      machine: {
        providersDir: options.providersDir,
        scratchDir: options.scratchDir,
        controllerUrl: pin.controllerUrl,
        baseEnv: process.env,
        binaryOf,
      },
    });

    const answerProbe = (request: ProbeRequest) => {
      const reporting = (result: ProbeResult) =>
        write(
          asText({
            _tag: "probeReport",
            requestId: request.requestId,
            instanceId: request.instanceId,
            result,
          }),
        );
      return Effect.gen(function* () {
        const adapter = adapterFor(request.providerId);
        return yield* reporting(
          adapter === undefined
            ? probeFailed(noAdapterFor(request.providerId))
            : yield* adapter.probe(contextFor(adapter, request.instanceId), request.config),
        );
      }).pipe(
        // The encoding is inside the catch: a result `asText` cannot carry must
        // reach the controller as an error, not as silence. The fallback is
        // bounded, so it always encodes.
        Effect.catchCause((cause) =>
          Effect.ignore(reporting(probeFailed(wentWrong(cause, MAX_FACT_LENGTH)))),
        ),
        // The connection is going if the write itself failed, and there is
        // nowhere left to report that to.
        Effect.ignore,
      );
    };

    /**
     * The facts go first, so a controller reading the row after an `ok` reads
     * the machine with the harness on it rather than as it was.
     */
    const answerInstall = (request: InstallRequest) => {
      const reporting = (outcome: InstallOutcome) =>
        write(
          asText({
            _tag: "installResult",
            requestId: request.requestId,
            ok: outcome.ok,
            ...(outcome.message === undefined ? {} : { message: outcome.message }),
          }),
        );
      return Effect.gen(function* () {
        const install = adapterFor(request.providerId)?.install;
        if (install === undefined) {
          return yield* reporting({ ok: false, message: noAdapterFor(request.providerId) });
        }
        const outcome = yield* install(process.env);
        if (outcome.ok) {
          yield* write(asText({ _tag: "factsReport", facts: yield* reportFacts }));
        }
        return yield* reporting(outcome);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.ignore(reporting({ ok: false, message: wentWrong(cause, MAX_FACT_LENGTH) })),
        ),
        Effect.ignore,
      );
    };

    /**
     * One half of a login. The child holding both belongs to the runner, not
     * this connection, so a socket dropping in between does not end it.
     */
    const answerLogin = (requestId: string, answering: Effect.Effect<LoginAnswer>) => {
      const reporting = (answer: LoginAnswer) => write(asText({ ...answer, requestId }));
      return Effect.flatMap(answering, reporting).pipe(
        Effect.catchCause((cause) =>
          Effect.ignore(
            reporting({ _tag: "loginFailed", message: wentWrong(cause, MAX_FACT_LENGTH) }),
          ),
        ),
        Effect.ignore,
      );
    };

    const startingLogin = (request: LoginStart): Effect.Effect<LoginAnswer> =>
      Effect.suspend(() => {
        const adapter = adapterFor(request.providerId);
        return adapter === undefined
          ? Effect.succeed<LoginAnswer>({
              _tag: "loginFailed",
              message: noAdapterFor(request.providerId),
            })
          : providerLogins.start(
              request.instanceId,
              adapter,
              contextFor(adapter, request.instanceId),
            );
      });

    const handle = (raw: string) =>
      Effect.gen(function* () {
        if (impostor !== undefined) return;
        const parsed = yield* Effect.option(
          Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }),
        );
        if (Option.isNone(parsed)) return yield* disown(UNREADABLE);
        // Read before the frame, because a later controller's hello will not
        // decode here, and the version is what an operator can act on.
        const version = yield* Effect.option(decodePeerVersion(parsed.value));
        if (Option.isSome(version) && version.value.protocolVersion !== PROTOCOL_VERSION) {
          return yield* Effect.fail(
            new ProtocolMismatch({
              message: `the controller speaks runner protocol version ${String(version.value.protocolVersion)}, this runner speaks ${String(PROTOCOL_VERSION)}`,
            }),
          );
        }
        const frame = yield* Effect.option(decodeFrame(parsed.value));
        if (Option.isNone(frame)) return yield* disown(UNREADABLE);
        const message = frame.value;
        if (message._tag === "controllerHello") {
          // A second hello can only weaken what the first settled.
          if (greeted) return;
          if (!(yield* isOurs(message, pin, nonce))) {
            return yield* disown("that is not the controller this runner joined");
          }
          greeted = true;
          proven.openUnsafe();
          return;
        }
        // A peer that has not proved who it is gets no evidence this runner is alive.
        if (!greeted) return;
        switch (message._tag) {
          case "ping":
            return yield* write(asText({ _tag: "pong" }));
          case "factsRequest":
            // Sent whatever the probe finds, unlike the hourly report: the
            // controller asked because somebody is waiting for an answer.
            return yield* write(asText({ _tag: "factsReport", facts: yield* reportFacts }));
          case "probeRequest":
            // Forked: a probe takes seconds, and the connection has to keep
            // answering pings and further requests while it runs.
            return yield* Effect.asVoid(Effect.forkIn(answerProbe(message), connection));
          case "installRequest":
            return yield* Effect.asVoid(Effect.forkIn(answerInstall(message), connection));
          case "loginStart":
            return yield* Effect.asVoid(
              Effect.forkIn(answerLogin(message.requestId, startingLogin(message)), connection),
            );
          case "loginCode":
            return yield* Effect.asVoid(
              Effect.forkIn(
                answerLogin(
                  message.requestId,
                  providerLogins.submit(message.instanceId, message.code),
                ),
                connection,
              ),
            );
          // Sessions run in the frame order they arrived in, unforked: input for
          // a session started one frame ago must not overtake the start.
          case "sessionStart":
            return yield* supervisor.start(message);
          case "sessionInput":
            return yield* supervisor.input(message);
          case "sessionInterrupt":
            return yield* supervisor.interrupt(message);
          case "sessionRespond":
            // No adapter holds a park yet, so there is no answer to deliver:
            // nothing can be parked before anything can park.
            return;
          case "sessionStop":
            return yield* supervisor.stop(message);
          case "ack":
            // Acks belong to the replayable events nothing sends yet.
            return;
        }
        // Every frame the protocol declares is answered above. A new one that
        // reaches here would otherwise be dropped in silence.
        return message satisfies never;
      });

    // The transport forks a fiber per frame, so two frames arriving together
    // would otherwise run the exchange twice over the same three flags.
    const frames = yield* Semaphore.make(1);
    const receive = (raw: string) => frames.withPermits(1)(handle(raw));

    /**
     * The deadline is only ever the answer before the proof arrives: one that
     * could still fire on a proven connection would hang a healthy runner up
     * every ten seconds for the life of the process.
     */
    const reporting = Effect.gen(function* () {
      yield* opened.await;
      const proved = yield* Effect.raceFirst(
        Effect.as(proven.await, true),
        Effect.as(Effect.sleep(options.proofDeadline ?? PROOF_DEADLINE), false),
      );
      if (!proved) return yield* disown("the controller did not say who it is");
      // Not a moment earlier: a session this runner kept across a reconnect can
      // produce events at once, and a peer that has not proved who it is reads
      // none of them. Running the relay is what subscribes it, so anything
      // published before this point is lost - the same gap as everything
      // produced while the socket was down (spec 03 section 2.3).
      yield* Effect.forkIn(supervisor.relay, connection);
      yield* supervisor.report;
      yield* Effect.all(
        [
          checkWatermark({
            read: options.headroom,
            send: (watermark) => write(asText({ _tag: "watermarkReport", watermark })),
          }),
          refreshFacts({
            probe: reportFacts,
            reported: options.facts,
            send: (probed) => write(asText({ _tag: "factsReport", facts: probed })),
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
            capabilities: [],
            binaryVersion: VERSION,
            nonce,
            facts: options.facts,
          }),
        ).pipe(Effect.ignore, Effect.andThen(Effect.sync(() => opened.openUnsafe()))),
      }),
      reporting,
    ).pipe(
      // However the connection ended, being hung up on by an impostor is the
      // more useful answer than the close that followed it.
      Effect.catch((error) => (impostor === undefined ? Effect.fail(error) : Effect.void)),
      // The one close reason this end reads: it says the credential is gone,
      // which no amount of dialling again will bring back.
      Effect.catch((error) =>
        Effect.fail(retiredIn(error) ? new RunnerRetired({ message: RETIRED_MESSAGE }) : error),
      ),
    );

    if (impostor !== undefined) return yield* Effect.fail(impostor);
  }).pipe(Effect.scoped);
