/**
 * The runner's end of one connection to the controller. `./reconnect.ts`
 * opens a new one when it ends.
 *
 * The credential is sent in a header on the WebSocket upgrade request. The
 * runner controls its own HTTP client, so it can set that header, which a
 * browser cannot.
 *
 * A controller is a logical identity, not an address. So the runner sends a
 * fresh nonce, and the controller's hello must match all three of:
 *
 * - the pinned identity id;
 * - the pinned public key;
 * - a valid signature over the nonce and this runner's id.
 *
 * A known id alone is not enough to trust whatever key comes with it.
 */
import { mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/unstable/socket/Socket";
import { VERSION } from "@hercule/home/version";
import {
  ControllerToRunner,
  PeerVersion,
  PROTOCOL_VERSION,
  RETIRED_CLOSE_CODE,
  RETIRED_CLOSE_REASON,
  RunnerToController,
  LOGIN_ENDED_CAPABILITY,
  buildWorkspaceActionCapability,
  encodeChallengeBytes,
  type ControllerHello,
  MAX_FACT_LENGTH,
  type InstallRequest,
  type LoginStart,
  type ProbeRequest,
  type ProbeResult,
  type RunnerFacts,
  type RunnerWatermark,
  MAX_MESSAGE_LENGTH,
  MAX_WORKSPACE_STEPS,
  type WorkspaceReport,
} from "@hercule/protocol";
import type { CredentialRelay } from "./credentials";
import { refreshFacts } from "./probe";
import { describeCause } from "./report";
import {
  findAdapter,
  describeMissingAdapter,
  buildFailedProbe,
  providerLogins,
  type InstallOutcome,
  type ProviderAdapter,
  type ProviderRunnerContext,
} from "./providers";
import type { LoginAnswer } from "./providers/login";
import { sessions } from "./sessions";
import { reportWatermark } from "./watermark";
import { WORKSPACE_ACTION_IDS, type WorkspaceSteps } from "./workspace-actions";
import type { Workspaces } from "./workspaces";

const SOCKET_PATH = "/api/v1/runners/socket";

const NONCE_BYTES = 16;

/**
 * The capabilities this runner offers at hello:
 *
 * - one for each workspace action its build implements. The controller pins a
 *   run only to a runner that lists every workspace action in the run's plan.
 * - `LOGIN_ENDED_CAPABILITY`: this runner reports the end of a device login.
 */
const CAPABILITIES: ReadonlyArray<string> = [
  ...WORKSPACE_ACTION_IDS.map(buildWorkspaceActionCapability),
  LOGIN_ENDED_CAPABILITY,
];

const ED25519 = { name: "Ed25519" } as const;

/** The RFC 6455 protocol-error close code. */
const PROTOCOL_ERROR = 1002;

/**
 * How long the controller has to prove its identity after the connection
 * opens. Until then the connection has passed no check, so there is no reason
 * to wait long.
 */
export const PROOF_DEADLINE: Duration.Duration = Duration.seconds(10);

/** The fields of `runner.json` that identify the controller this runner belongs to. */
export interface ControllerPin {
  /** This runner's id at that controller. The controller's hello signs it together with the nonce. */
  readonly runnerId: string;
  readonly controllerUrl: string;
  readonly credential: string;
  readonly controllerIdentityId: string;
  /** The raw SPKI bytes, in standard base64. */
  readonly controllerPublicKey: string;
}

export interface ConnectOptions {
  readonly pin: ControllerPin;
  readonly facts: RunnerFacts;
  readonly probe: Effect.Effect<RunnerFacts>;
  readonly headroom: Effect.Effect<RunnerWatermark, Cause.UnknownError>;
  /**
   * The directory that holds one config directory per provider instance on
   * this machine. Each instance has its own, so two accounts of one harness
   * never read each other's credentials, or the user's own.
   */
  readonly providersDir: string;
  /**
   * The directory that holds the empty working directory of each session
   * without a workspace. Each one is removed when its session exits
   * (spec 06 section 9.1).
   */
  readonly scratchDir: string;
  /** The workspaces on this machine. Creates new ones when the controller asks. */
  readonly workspaces: Workspaces;
  /** The workspace steps on this machine. They outlive this connection. */
  readonly workspaceSteps: WorkspaceSteps;
  /** The socket this machine's credential helper asks for tokens on. */
  readonly socketPath: string;
  /** Forwards a credential helper's request to the controller, and the response back. */
  readonly credentials: CredentialRelay;
  /** `<home>/runner/bin`, holding the `hercule` symlink every session gets on `PATH`. */
  readonly binDir: string;
  /** How sessions call Hercule as a tool, resolved once at runner start (spec 06 section 9.3). */
  readonly herculeTool: ProviderRunnerContext["herculeTool"];
  /** Defaults to `PROOF_DEADLINE`. Tests set a shorter one. */
  readonly proofDeadline?: Duration.Duration;
}

/**
 * The peer did not prove it is the controller this runner joined. This is its
 * own error because retrying will not fix it: something is impersonating the
 * controller, the URL points at the wrong one, or `runner.json` is invalid.
 */
export class ControllerNotRecognised extends Schema.TaggedError<ControllerNotRecognised>()(
  "ControllerNotRecognised",
  { message: Schema.String },
) {}

/**
 * The controller has retired this runner and revoked its credential. This is
 * its own error because reconnecting is exactly the wrong response: the
 * reconnect loop stops, and the daemon tells the operator what to do.
 */
export class RunnerRetired extends Schema.TaggedError<RunnerRetired>()("RunnerRetired", {
  message: Schema.String,
}) {}

export const RETIRED_MESSAGE =
  "this runner was retired; run `hercule runner join` to join the fleet again";

/**
 * The controller uses another protocol version. This is its own error because
 * the operator can fix it by running the same Hercule version on both sides.
 */
export class ProtocolMismatch extends Schema.TaggedError<ProtocolMismatch>()("ProtocolMismatch", {
  message: Schema.String,
}) {}

const decodeFrame = Schema.decodeUnknownEffect(ControllerToRunner);
const decodePeerVersion = Schema.decodeUnknownEffect(PeerVersion);

const UNREADABLE = "the controller sent a message this version of the runner cannot parse";
const encodeFrame = Schema.encodeUnknownSync(RunnerToController);

const encodeFrameText = (message: typeof RunnerToController.Type): string =>
  JSON.stringify(encodeFrame(message));

/** Decodes base64 into the `Uint8Array<ArrayBuffer>` WebCrypto's types require. A Node `Buffer` does not fit that type. */
const decodeBase64 = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
};

const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const isRetiredClose = (error: unknown): boolean =>
  error instanceof Socket.SocketError &&
  error.reason._tag === "SocketCloseError" &&
  error.reason.code === RETIRED_CLOSE_CODE &&
  error.reason.closeReason === RETIRED_CLOSE_REASON;

const buildSocketUrl = (controllerUrl: string): string => {
  const url = new URL(SOCKET_PATH, controllerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

/**
 * Checks that a controller hello matches the pinned identity id and public key
 * and carries a valid signature over the nonce and this runner's id. The
 * signature is checked last, because the key is only trusted once the id and
 * the key match the pin.
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
          decodeBase64(pin.controllerPublicKey),
          ED25519,
          false,
          ["verify"],
        );
        return crypto.subtle.verify(
          ED25519,
          key,
          decodeBase64(hello.signature),
          encodeChallengeBytes(pin.runnerId, nonce),
        );
      }).pipe(
        // A pinned key that cannot be imported cannot verify anything.
        Effect.catchCause(() => Effect.succeed(false)),
      );

/**
 * Opens one connection to the controller, checks its identity, and serves it
 * until it ends. Every ending is a failure, even a normal close, because a
 * disconnected runner must reconnect. Fails with:
 *
 * - `ControllerNotRecognised` when the peer does not prove it is this runner's controller;
 * - `ProtocolMismatch` when the controller uses another protocol version;
 * - `RunnerRetired` when the controller has retired this runner;
 * - `SocketError` for any other ending.
 */
export const connect = (
  options: ConnectOptions,
): Effect.Effect<
  void,
  ControllerNotRecognised | ProtocolMismatch | RunnerRetired | Socket.SocketError
> =>
  Effect.gen(function* () {
    const { pin } = options;
    const url = buildSocketUrl(pin.controllerUrl);
    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(url, {
              headers: { authorization: `Bearer ${pin.credential}` },
            } as unknown as string[]),
        ),
        // A socket still open when this scope closes means the runner is
        // leaving on purpose, not losing the connection. The goodbye frame lets
        // the controller tell a clean shutdown from a lost connection. It is
        // sent on the raw socket, because everything above it is already
        // shutting down.
        (ws) =>
          Effect.sync(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrameText({ _tag: "goodbye" }));
            ws.close(1000);
          }),
      ),
    );
    const write = yield* socket.writer;
    // A probe or an install runs longer than the handling of the frame that
    // asked for it, so it is forked into the connection's scope, not the
    // transport's per-frame fiber.
    const connection = yield* Effect.scope;

    const nonce = encodeBase64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
    let greeted = false;
    // The machine's facts as this connection last reported them. An install
    // changes the machine, and the probe after it must find the binary that
    // was just installed, not the one listed in the hello.
    let facts = options.facts;
    const proven = Latch.makeUnsafe(false);
    // The proof deadline starts when the socket opens. It limits how long the
    // peer takes to respond, not how long the network takes to connect.
    // Otherwise a slow connect could leave a valid controller no time to
    // prove its identity.
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

    const findBinaryPath = (binaryName: string): string | undefined =>
      facts.providers.find((provider) => provider.name === binaryName && provider.present)?.path;

    /**
     * Builds the context for a probe, login or install of one provider
     * instance. Creates the instance's private directory, where the harness
     * keeps its credentials.
     */
    const buildContext = (
      adapter: ProviderAdapter,
      instanceId: string,
      secrets: Readonly<Record<string, string>>,
    ): ProviderRunnerContext => {
      const home = joinPath(options.providersDir, instanceId);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // Probes, logins and installs have no working directory. Only sessions
      // have one, and the session supervisor builds its own context
      // (spec 06 section 4.2).
      return {
        cwd: null,
        home,
        binary: findBinaryPath(adapter.binaryName),
        env: process.env,
        secrets,
        // Required by the shared context type, although a probe, an install and
        // a login never load the skill.
        herculeTool: options.herculeTool,
      };
    };

    // The connection gives the supervisor a way to send frames and the paths
    // this machine resolved. The sessions themselves belong to the process,
    // not to this connection.
    const supervisor = sessions.forConnection({
      send: (frame) => write(encodeFrameText(frame)),
      machine: {
        providersDir: options.providersDir,
        scratchDir: options.scratchDir,
        binDir: options.binDir,
        herculeTool: options.herculeTool,
        controllerUrl: pin.controllerUrl,
        baseEnv: process.env,
        binaryOf: findBinaryPath,
        workspaces: options.workspaces,
        socketPath: options.socketPath,
      },
    });

    // Credential requests go out on this connection while it is up. With no
    // connection there is no credential, which git treats as "try the next
    // helper", not as a failure.
    yield* options.credentials.attachConnection((frame) => write(encodeFrameText(frame)));

    /**
     * Runs a workspace operation and sends its report. Provisioning takes as
     * long as a clone, so the caller forks this and the report is sent when
     * it is done. The controller waits for a report for every workspace frame
     * it sent, so even a crash sends a failed report.
     */
    const answerWorkspace = (
      workspaceId: string,
      making: () => Promise<WorkspaceReport>,
    ): Effect.Effect<void> =>
      Effect.promise(making).pipe(
        Effect.flatMap((report) => write(encodeFrameText(report))),
        Effect.catchCause((cause) =>
          Effect.ignore(
            write(
              encodeFrameText({
                _tag: "workspaceReport",
                workspaceId,
                status: "failed",
                message: describeCause(cause, MAX_MESSAGE_LENGTH),
              }),
            ),
          ),
        ),
        Effect.ignore,
      );

    const answerProbe = (request: ProbeRequest) => {
      const sendProbeReport = (result: ProbeResult) =>
        write(
          encodeFrameText({
            _tag: "probeReport",
            requestId: request.requestId,
            instanceId: request.instanceId,
            result,
          }),
        );
      return Effect.gen(function* () {
        const adapter = findAdapter(request.providerId);
        return yield* sendProbeReport(
          adapter === undefined
            ? buildFailedProbe(null, describeMissingAdapter(request.providerId))
            : yield* adapter.probe(
                buildContext(adapter, request.instanceId, request.secrets),
                request.config,
              ),
        );
      }).pipe(
        // The encoding happens inside the catch, so a result that cannot be
        // encoded reaches the controller as an error, not as silence. The
        // fallback message is truncated, so it always encodes.
        Effect.catchCause((cause) =>
          Effect.ignore(
            sendProbeReport(buildFailedProbe(null, describeCause(cause, MAX_FACT_LENGTH))),
          ),
        ),
        // If the write itself failed, the connection is closing and there is
        // nowhere left to report to.
        Effect.ignore,
      );
    };

    /**
     * Runs an install and sends its result. After a successful install, the
     * new facts are sent first, so a controller that reads the runner row
     * after the `ok` sees the machine with the harness installed.
     */
    const answerInstall = (request: InstallRequest) => {
      const sendInstallResult = (outcome: InstallOutcome) =>
        write(
          encodeFrameText({
            _tag: "installResult",
            requestId: request.requestId,
            ok: outcome.ok,
            ...(outcome.message === undefined ? {} : { message: outcome.message }),
          }),
        );
      return Effect.gen(function* () {
        const install = findAdapter(request.providerId)?.install;
        if (install === undefined) {
          return yield* sendInstallResult({
            ok: false,
            message: describeMissingAdapter(request.providerId),
          });
        }
        const outcome = yield* install(process.env);
        if (outcome.ok) {
          yield* write(encodeFrameText({ _tag: "factsReport", facts: yield* reportFacts }));
        }
        return yield* sendInstallResult(outcome);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.ignore(
            sendInstallResult({ ok: false, message: describeCause(cause, MAX_FACT_LENGTH) }),
          ),
        ),
        Effect.ignore,
      );
    };

    /**
     * Sends the response to one step of a login: the start or the code. The
     * login process belongs to the runner, not to this connection, so a
     * connection that drops between the two steps does not end it.
     */
    const answerLogin = (requestId: string, answering: Effect.Effect<LoginAnswer>) => {
      const sendLoginAnswer = (answer: LoginAnswer) =>
        write(encodeFrameText({ ...answer, requestId }));
      return Effect.flatMap(answering, sendLoginAnswer).pipe(
        Effect.catchCause((cause) =>
          Effect.ignore(
            sendLoginAnswer({
              _tag: "loginFailed",
              message: describeCause(cause, MAX_FACT_LENGTH),
            }),
          ),
        ),
        Effect.ignore,
      );
    };

    const startLogin = (request: LoginStart): Effect.Effect<LoginAnswer> =>
      Effect.suspend(() => {
        const adapter = findAdapter(request.providerId);
        return adapter === undefined
          ? Effect.succeed<LoginAnswer>({
              _tag: "loginFailed",
              message: describeMissingAdapter(request.providerId),
            })
          : providerLogins.start(
              request.instanceId,
              adapter,
              // A login is the harness writing its own credential on this
              // machine, so the instance's stored secrets are not passed in.
              buildContext(adapter, request.instanceId, {}),
            );
      });

    const handleFrame = (raw: string) =>
      Effect.gen(function* () {
        if (impostor !== undefined) return;
        const parsed = yield* Effect.option(
          Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }),
        );
        if (Option.isNone(parsed)) return yield* disown(UNREADABLE);
        // Read the version before decoding the frame, because a newer
        // controller's hello may not decode here, and a version mismatch is
        // an error the operator can act on.
        const version = yield* Effect.option(decodePeerVersion(parsed.value));
        if (Option.isSome(version) && version.value.protocolVersion !== PROTOCOL_VERSION) {
          return yield* Effect.fail(
            new ProtocolMismatch({
              message: `the controller uses runner protocol version ${String(version.value.protocolVersion)}, but this runner uses version ${String(PROTOCOL_VERSION)}. Install the same Hercule version here as on the controller.`,
            }),
          );
        }
        const frame = yield* Effect.option(decodeFrame(parsed.value));
        if (Option.isNone(frame)) return yield* disown(UNREADABLE);
        const message = frame.value;
        if (message._tag === "controllerHello") {
          // Ignore a second hello: it could only undo the proof the first one gave.
          if (greeted) return;
          if (!(yield* isOurs(message, pin, nonce))) {
            return yield* disown(
              "the controller's identity does not match the controller this runner joined",
            );
          }
          greeted = true;
          // Step results go out on this connection from now on, before any
          // step frame is handled, so no answer is lost. Not earlier: a step
          // started on an earlier connection can finish at any moment, and a
          // peer that has not proved its identity must not learn of it.
          yield* options.workspaceSteps
            .attachConnection((frame) => write(encodeFrameText(frame)))
            .pipe(Scope.provide(connection));
          // An older controller closes the connection on a frame it cannot
          // read, so the end of a device login is reported only to a
          // controller that lists the frame.
          if (message.capabilities.includes(LOGIN_ENDED_CAPABILITY)) {
            yield* providerLogins
              .attachConnection((frame) => write(encodeFrameText(frame)))
              .pipe(Scope.provide(connection));
          }
          proven.openUnsafe();
          return;
        }
        // Send nothing to a peer that has not proved its identity, not even a sign that this runner is alive.
        if (!greeted) return;
        switch (message._tag) {
          case "ping":
            return yield* write(encodeFrameText({ _tag: "pong" }));
          case "factsRequest":
            // Unlike the hourly report, this is sent even when nothing changed,
            // because someone is waiting for the response.
            return yield* write(
              encodeFrameText({ _tag: "factsReport", facts: yield* reportFacts }),
            );
          case "probeRequest":
            // Forked, because a probe takes seconds, and the connection must keep
            // handling pings and other requests while it runs.
            return yield* Effect.asVoid(Effect.forkIn(answerProbe(message), connection));
          case "installRequest":
            return yield* Effect.asVoid(Effect.forkIn(answerInstall(message), connection));
          case "loginStart":
            return yield* Effect.asVoid(
              Effect.forkIn(answerLogin(message.requestId, startLogin(message)), connection),
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
          // Session frames are handled in arrival order, without forking, so
          // input for a session cannot overtake the frame that started it.
          case "sessionStart":
            return yield* supervisor.start(message);
          case "sessionInput":
            return yield* supervisor.input(message);
          case "sessionInterrupt":
            return yield* supervisor.interrupt(message);
          case "sessionRespondToApprovalRequest":
            return yield* supervisor.respondToApprovalRequest(message);
          case "sessionRespondToQuestion":
            return yield* supervisor.respondToQuestion(message);
          case "sessionStop":
            return yield* supervisor.stop(message);
          case "ack":
            // Acks are for replayable events, which nothing sends yet.
            return;
          case "workspaceProvision": {
            // Started here, before the next frame is handled, and not in the
            // forked fiber: a workspace step sent right after this frame must
            // find the provisioning in progress and wait for it, instead of
            // finding no workspace at all.
            const provisioning = options.workspaces.provision(message);
            return yield* Effect.asVoid(
              Effect.forkIn(
                answerWorkspace(message.workspaceId, () => provisioning),
                connection,
              ),
            );
          }
          case "workspaceDispose":
            return yield* Effect.asVoid(
              Effect.forkIn(
                answerWorkspace(message.workspaceId, () => options.workspaces.dispose(message)),
                connection,
              ),
            );
          case "credentialAnswer":
            // A git process is waiting for this response. Nothing is kept after
            // it is delivered.
            return yield* Effect.sync(() => options.credentials.deliver(message));
          // A step runs in a fiber of its own, so these return at once.
          case "workspaceStepStart":
            return yield* options.workspaceSteps.start(message);
          case "workspaceStepSettle":
            return yield* options.workspaceSteps.settle(message);
        }
        // Every frame the protocol defines is handled above. This fails to
        // compile when a new frame is added, so it cannot be dropped silently.
        return message satisfies never;
      });

    // The transport forks a fiber per frame. Without this lock, two frames
    // arriving together could run the hello check at the same time over the
    // same shared state.
    const frames = yield* Semaphore.make(1);
    const receive = (raw: string) => frames.withPermits(1)(handleFrame(raw));

    /**
     * Waits for the proof, then starts the session relay and the periodic
     * reports. The deadline applies only until the proof arrives. A deadline
     * that could fire on a proven connection would disconnect a healthy
     * runner every ten seconds.
     */
    const reporting = Effect.gen(function* () {
      yield* opened.await;
      const proved = yield* Effect.raceFirst(
        Effect.as(proven.await, true),
        Effect.as(Effect.sleep(options.proofDeadline ?? PROOF_DEADLINE), false),
      );
      if (!proved) return yield* disown("the controller did not prove its identity in time");
      // Logged only now, because before the proof the peer may not be this
      // runner's controller. Every lost connection is logged as a warning, so
      // this line shows in the log when the runner got its connection back.
      yield* Effect.logInfo("The runner connected to the controller").pipe(
        Effect.annotateLogs({ controllerUrl: pin.controllerUrl, runnerId: pin.runnerId }),
      );
      // Start the relay only now. A session that survived a reconnect can
      // produce events at once, and a peer that has not proved its identity
      // must not receive any of them. The relay subscribes when it starts, so
      // events published before this point are lost, like everything produced
      // while the socket was down: the runner has no outbox yet that keeps
      // events for replay (spec 03 section 2.3).
      yield* Effect.forkIn(supervisor.relay, connection);
      yield* supervisor.report;
      // Like the sessions report: the controller settles every listed step
      // whose record ended while this runner was away. One frame holds at
      // most `MAX_WORKSPACE_STEPS` steps, so a longer list is sent in parts.
      const inFlight = options.workspaceSteps.listInFlight();
      for (let at = 0; at < inFlight.length; at += MAX_WORKSPACE_STEPS) {
        yield* write(
          encodeFrameText({
            _tag: "workspaceStepsReport",
            steps: inFlight.slice(at, at + MAX_WORKSPACE_STEPS),
          }),
        );
      }
      yield* Effect.all(
        [
          reportWatermark({
            read: options.headroom,
            send: (watermark) => write(encodeFrameText({ _tag: "watermarkReport", watermark })),
          }),
          refreshFacts({
            probe: reportFacts,
            reported: options.facts,
            send: (probed) => write(encodeFrameText({ _tag: "factsReport", facts: probed })),
          }),
        ],
        { concurrency: "unbounded" },
      );
    });

    // `raceFirst`, not `race`: the connection ending is a failure, and `race`
    // would ignore that failure and keep waiting for the other side.
    yield* Effect.raceFirst(
      socket.runString(receive, {
        onOpen: write(
          encodeFrameText({
            _tag: "runnerHello",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: CAPABILITIES,
            binaryVersion: VERSION,
            nonce,
            facts: options.facts,
          }),
        ).pipe(Effect.ignore, Effect.andThen(Effect.sync(() => opened.openUnsafe()))),
      }),
      reporting,
    ).pipe(
      // When the runner closed the connection on an impostor, report that
      // instead of the close error that followed.
      Effect.catch((error) => (impostor === undefined ? Effect.fail(error) : Effect.void)),
      // The only close reason the runner checks. It means the credential is
      // revoked, and reconnecting will not bring it back.
      Effect.catch((error) =>
        Effect.fail(
          isRetiredClose(error) ? new RunnerRetired({ message: RETIRED_MESSAGE }) : error,
        ),
      ),
    );

    if (impostor !== undefined) return yield* Effect.fail(impostor);
  }).pipe(Effect.scoped);
